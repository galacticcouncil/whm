use anchor_lang::prelude::*;
use wormhole_anchor_sdk::wormhole::{
    self, program::Wormhole, BridgeData, FeeCollector, Finality, SEED_PREFIX_EMITTER,
};

use crate::helpers::{abi_encode_price_payload, abi_encode_string};
use crate::oracle::{normalize_to_18dec, read_price};
use crate::stake_pool;
use crate::state::{PriceFeed, StakePoolFeed};

const ACTION_ORACLE_PRICE: u8 = 1;
const ACTION_STAKE_RATE: u8 = 2;

#[cfg(feature = "local-logs")]
macro_rules! dev_msg {
    ($($arg:tt)*) => {
        msg!($($arg)*);
    };
}

#[cfg(not(feature = "local-logs"))]
macro_rules! dev_msg {
    ($($arg:tt)*) => {};
}

#[derive(Accounts)]
pub struct SendMessage<'info> {
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, crate::state::Config>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [BridgeData::SEED_PREFIX],
        bump,
        seeds::program = wormhole_program.key(),
    )]
    pub wormhole_bridge: Account<'info, BridgeData>,

    /// CHECK: Fresh Keypair for this message, created by the client as a tx signer.
    #[account(mut, signer)]
    pub wormhole_message: Signer<'info>,

    /// CHECK: Emitter PDA of this program - acts as the Wormhole message source.
    #[account(seeds = [SEED_PREFIX_EMITTER], bump)]
    pub emitter: UncheckedAccount<'info>,

    /// CHECK: Initialized by the Wormhole program on the first message.
    #[account(mut)]
    pub wormhole_sequence: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [FeeCollector::SEED_PREFIX],
        bump,
        seeds::program = wormhole_program.key(),
    )]
    pub wormhole_fee_collector: Account<'info, FeeCollector>,

    pub clock: Sysvar<'info, Clock>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
    pub wormhole_program: Program<'info, Wormhole>,
}

#[derive(Accounts)]
pub struct SendPrice<'info> {
    /// Owner-registered binding: asset_id <-> oracle indexes.
    #[account(seeds = [b"price_feed".as_ref(), price_feed.asset_id.as_ref()], bump)]
    pub price_feed: Account<'info, PriceFeed>,

    /// CHECK: Kamino Scope OraclePrices account.
    pub scope_prices: UncheckedAccount<'info>,

    /// Embedded Wormhole accounts (config, payer, bridge, emitter, etc.)
    pub wormhole: SendMessage<'info>,
}

#[derive(Accounts)]
pub struct SendRate<'info> {
    /// Owner-registered binding: asset_id <-> stake pool.
    #[account(seeds = [b"stake_pool_feed".as_ref(), stake_pool_feed.asset_id.as_ref()], bump)]
    pub stake_pool_feed: Account<'info, StakePoolFeed>,

    /// CHECK: SPL Stake Pool account — must match the registered stake_pool pubkey.
    #[account(address = stake_pool_feed.stake_pool)]
    pub stake_pool: UncheckedAccount<'info>,

    /// Embedded Wormhole accounts (config, payer, bridge, emitter, etc.)
    pub wormhole: SendMessage<'info>,
}

pub(crate) fn send_message(ctx: Context<SendMessage>, message: String) -> Result<()> {
    let payload = abi_encode_string(&message);
    post_wormhole_message(&ctx.accounts, ctx.bumps.emitter, payload)
}

pub(crate) fn send_price(ctx: Context<SendPrice>) -> Result<()> {
    let feed = &ctx.accounts.price_feed;

    let oracle_data = ctx.accounts.scope_prices.try_borrow_data()?;
    let price_entry = read_price(&oracle_data, feed.price_index)?;
    drop(oracle_data);

    let usd_price = normalize_to_18dec(&price_entry)?;

    dev_msg!(
        "send_price: price_index={}",
        feed.price_index
    );
    dev_msg!(
        "send_price: price.value={} price.exp={} price.ts={} price.slot={}",
        price_entry.price.value,
        price_entry.price.exp,
        price_entry.unix_timestamp,
        price_entry.last_updated_slot
    );
    dev_msg!("send_price: usd_price_18dec={}", usd_price);

    let payload = abi_encode_price_payload(
        ACTION_ORACLE_PRICE,
        feed.asset_id,
        usd_price,
        price_entry.unix_timestamp,
    );

    post_wormhole_message(&ctx.accounts.wormhole, ctx.bumps.wormhole.emitter, payload)
}

pub(crate) fn send_rate(ctx: Context<SendRate>) -> Result<()> {
    let feed = &ctx.accounts.stake_pool_feed;

    let pool_data = ctx.accounts.stake_pool.try_borrow_data()?;
    let pool = stake_pool::read_stake_pool(&pool_data)?;
    drop(pool_data);

    let rate = stake_pool::compute_rate(&pool)?;
    let timestamp = ctx.accounts.wormhole.clock.unix_timestamp as u64;

    dev_msg!(
        "send_rate: total_lamports={} pool_token_supply={} epoch={}",
        pool.total_lamports,
        pool.pool_token_supply,
        pool.last_update_epoch
    );
    dev_msg!("send_rate: rate_18dec={}", rate);

    let payload = abi_encode_price_payload(
        ACTION_STAKE_RATE,
        feed.asset_id,
        rate,
        timestamp,
    );

    post_wormhole_message(&ctx.accounts.wormhole, ctx.bumps.wormhole.emitter, payload)
}

/// Shared Wormhole fee-payment + post_message CPI.
pub(crate) fn post_wormhole_message(
    accounts: &SendMessage,
    emitter_bump: u8,
    payload: Vec<u8>,
) -> Result<()> {
    let fee = accounts.wormhole_bridge.fee();
    dev_msg!(
        "post_wormhole_message: fee={} payload_len={} emitter_bump={}",
        fee,
        payload.len(),
        emitter_bump
    );
    if fee > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: accounts.payer.to_account_info(),
                    to: accounts.wormhole_fee_collector.to_account_info(),
                },
            ),
            fee,
        )?;
    }

    wormhole::post_message(
        CpiContext::new_with_signer(
            accounts.wormhole_program.to_account_info(),
            wormhole::PostMessage {
                config: accounts.wormhole_bridge.to_account_info(),
                message: accounts.wormhole_message.to_account_info(),
                emitter: accounts.emitter.to_account_info(),
                sequence: accounts.wormhole_sequence.to_account_info(),
                payer: accounts.payer.to_account_info(),
                fee_collector: accounts.wormhole_fee_collector.to_account_info(),
                clock: accounts.clock.to_account_info(),
                rent: accounts.rent.to_account_info(),
                system_program: accounts.system_program.to_account_info(),
            },
            &[&[SEED_PREFIX_EMITTER, &[emitter_bump]]],
        ),
        0,
        payload,
        Finality::Finalized,
    )?;

    Ok(())
}
