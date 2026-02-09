use anchor_lang::prelude::*;
use wormhole_anchor_sdk::wormhole::{
    self, program::Wormhole, BridgeData, FeeCollector, Finality, SequenceTracker,
    SEED_PREFIX_EMITTER,
};

use crate::helpers::abi_encode_string;
use crate::state::Config;

#[derive(Accounts)]
pub struct SendMessage<'info> {
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,

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

    #[account(
        mut,
        seeds = [SequenceTracker::SEED_PREFIX, emitter.key().as_ref()],
        bump,
        seeds::program = wormhole_program.key(),
    )]
    pub wormhole_sequence: Account<'info, SequenceTracker>,

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

pub(crate) fn send_message(
    ctx: Context<SendMessage>,
    _target_chain: u16,
    _target_address: [u8; 32],
    message: String,
) -> Result<()> {
    let payload = abi_encode_string(&message);

    // Pay the Wormhole bridge fee
    let fee = ctx.accounts.wormhole_bridge.fee();
    if fee > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.wormhole_fee_collector.to_account_info(),
                },
            ),
            fee,
        )?;
    }

    // CPI to Wormhole post_message
    wormhole::post_message(
        CpiContext::new_with_signer(
            ctx.accounts.wormhole_program.to_account_info(),
            wormhole::PostMessage {
                config: ctx.accounts.wormhole_bridge.to_account_info(),
                message: ctx.accounts.wormhole_message.to_account_info(),
                emitter: ctx.accounts.emitter.to_account_info(),
                sequence: ctx.accounts.wormhole_sequence.to_account_info(),
                payer: ctx.accounts.payer.to_account_info(),
                fee_collector: ctx.accounts.wormhole_fee_collector.to_account_info(),
                clock: ctx.accounts.clock.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
            &[&[SEED_PREFIX_EMITTER, &[ctx.bumps.emitter]]],
        ),
        0,
        payload,
        Finality::Finalized,
    )?;

    Ok(())
}
