use anchor_lang::prelude::*;
use wormhole_anchor_sdk::wormhole::{
    self, program::Wormhole, BridgeData, FeeCollector, Finality, SEED_PREFIX_EMITTER,
};

use crate::helpers::abi_encode_string;

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

    /// CHECK: Emitter PDA of this program – acts as the Wormhole message source.
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

pub(crate) fn send_message(ctx: Context<SendMessage>, message: String) -> Result<()> {
    let payload = abi_encode_string(&message);
    post_wormhole_message(&ctx.accounts, ctx.bumps.emitter, payload)
}

/// Shared Wormhole fee-payment + post_message CPI.
pub(crate) fn post_wormhole_message(
    accounts: &SendMessage,
    emitter_bump: u8,
    payload: Vec<u8>,
) -> Result<()> {
    let fee = accounts.wormhole_bridge.fee();
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
