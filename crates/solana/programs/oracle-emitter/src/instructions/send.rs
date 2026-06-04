use anchor_lang::prelude::*;

use wormhole_post_message_shim::{program::WormholePostMessageShim, Finality};

use crate::helpers::abi_encode_price_payload;
use crate::oracle::{normalize_to_18dec, read_price};
use crate::stake_pool;
use crate::state::{PriceFeed, StakePoolFeed};

use crate::wormhole::{BridgeData, CORE_BRIDGE_CONFIG, CORE_BRIDGE_FEE_COLLECTOR, CORE_BRIDGE_PROGRAM_ID};

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
pub struct PostMessage<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub wormhole_post_message_shim: Program<'info, WormholePostMessageShim>,

    /// CHECK: Wormhole Core Bridge config — owned by the Wormhole program.
    #[account(mut, address = CORE_BRIDGE_CONFIG, owner = CORE_BRIDGE_PROGRAM_ID)]
    pub bridge: UncheckedAccount<'info>,

    /// CHECK: Shim-managed message PDA (reused per emitter).
    #[account(mut, seeds = [&emitter.key.to_bytes()], bump, seeds::program = wormhole_post_message_shim::ID)]
    pub message: UncheckedAccount<'info>,

    /// CHECK: Emitter PDA of this program.
    #[account(seeds = [b"emitter"], bump)]
    pub emitter: UncheckedAccount<'info>,

    /// CHECK: Emitter's sequence account.
    #[account(mut)]
    pub sequence: UncheckedAccount<'info>,

    /// CHECK: Wormhole fee collector.
    #[account(mut, address = CORE_BRIDGE_FEE_COLLECTOR)]
    pub fee_collector: UncheckedAccount<'info>,

    pub clock: Sysvar<'info, Clock>,
    pub system_program: Program<'info, System>,

    /// CHECK: Wormhole Core Bridge program.
    #[account(address = CORE_BRIDGE_PROGRAM_ID)]
    pub wormhole_program: UncheckedAccount<'info>,

    /// CHECK: Shim event authority. Enforced by the shim.
    pub wormhole_post_message_shim_ea: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SendPrice<'info> {
    /// Owner-registered binding: asset_id <-> oracle indexes.
    #[account(seeds = [b"price_feed".as_ref(), price_feed.asset_id.as_ref()], bump)]
    pub price_feed: Account<'info, PriceFeed>,

    /// CHECK: Kamino Scope OraclePrices account — must match the registered address.
    #[account(address = price_feed.scope_prices)]
    pub scope_prices: UncheckedAccount<'info>,

    /// Embedded Wormhole accounts (config, payer, bridge, emitter, etc.)
    pub wormhole: PostMessage<'info>,
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
    pub wormhole: PostMessage<'info>,
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

/// Shared Wormhole shim post_message CPI.
pub(crate) fn post_wormhole_message(
    accounts: &PostMessage,
    emitter_bump: u8,
    payload: Vec<u8>,
) -> Result<()> {
    let bridge = BridgeData::try_from_slice(&accounts.bridge.try_borrow_data()?)?;
    let fee = bridge.fee();

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
                    to: accounts.fee_collector.to_account_info(),
                },
            ),
            fee,
        )?;
    }

    wormhole_post_message_shim::cpi::post_message(
        CpiContext::new_with_signer(
            accounts.wormhole_post_message_shim.to_account_info(),
            wormhole_post_message_shim::cpi::accounts::PostMessage {
                payer: accounts.payer.to_account_info(),
                bridge: accounts.bridge.to_account_info(),
                message: accounts.message.to_account_info(),
                emitter: accounts.emitter.to_account_info(),
                sequence: accounts.sequence.to_account_info(),
                fee_collector: accounts.fee_collector.to_account_info(),
                clock: accounts.clock.to_account_info(),
                system_program: accounts.system_program.to_account_info(),
                wormhole_program: accounts.wormhole_program.to_account_info(),
                program: accounts.wormhole_post_message_shim.to_account_info(),
                event_authority: accounts.wormhole_post_message_shim_ea.to_account_info(),
            },
            &[&[b"emitter", &[emitter_bump]]],
        ),
        0,
        Finality::Finalized,
        payload,
    )?;

    Ok(())
}
