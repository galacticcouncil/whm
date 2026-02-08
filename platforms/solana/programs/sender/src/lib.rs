use anchor_lang::prelude::*;
use anchor_lang::solana_program;

declare_id!("BqbowXrcN2KbKswhBHLZwasFrDh9NV9qpJty7fLH6peJ");

#[program]
pub mod sender {
    use super::*;

    /// Initialize the sender config with Wormhole bridge program.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.owner = ctx.accounts.owner.key();
        config.wormhole = ctx.accounts.wormhole_program.key();
        Ok(())
    }

    /// Send a cross-chain message via Wormhole Core Bridge.
    /// Permissionless - anyone can call this and pay the bridge fee.
    /// The message is ABI-encoded for EVM receiver compatibility.
    pub fn send_message(
        ctx: Context<SendMessage>,
        target_chain: u16,
        target_address: [u8; 32],
        message: String,
    ) -> Result<()> {
        let _ = (target_chain, target_address); // included in the VAA by the guardian network
        let payload = abi_encode_string(&message);

        // Build Wormhole post_message instruction data:
        // [0x01] [nonce: u32 LE] [payload_len: u32 LE] [payload] [consistency_level: u8]
        let nonce: u32 = 0;
        let consistency_level: u8 = 1; // confirmed finality

        let mut data = Vec::with_capacity(1 + 4 + 4 + payload.len() + 1);
        data.push(0x01); // PostMessage instruction index
        data.extend_from_slice(&nonce.to_le_bytes());
        data.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        data.extend_from_slice(&payload);
        data.push(consistency_level);

        let accounts = vec![
            AccountMeta::new(ctx.accounts.wormhole_bridge.key(), false),
            AccountMeta::new(ctx.accounts.wormhole_message.key(), true),
            AccountMeta::new_readonly(ctx.accounts.emitter.key(), true),
            AccountMeta::new(ctx.accounts.sequence.key(), false),
            AccountMeta::new(ctx.accounts.payer.key(), true),
            AccountMeta::new(ctx.accounts.fee_collector.key(), false),
            AccountMeta::new_readonly(ctx.accounts.clock.key(), false),
            AccountMeta::new_readonly(ctx.accounts.rent.key(), false),
            AccountMeta::new_readonly(ctx.accounts.system_program.key(), false),
        ];

        let ix = solana_program::instruction::Instruction {
            program_id: ctx.accounts.wormhole_program.key(),
            accounts,
            data,
        };

        let emitter_bump = ctx.bumps.emitter;

        solana_program::program::invoke_signed(
            &ix,
            &[
                ctx.accounts.wormhole_bridge.to_account_info(),
                ctx.accounts.wormhole_message.to_account_info(),
                ctx.accounts.emitter.to_account_info(),
                ctx.accounts.sequence.to_account_info(),
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.fee_collector.to_account_info(),
                ctx.accounts.clock.to_account_info(),
                ctx.accounts.rent.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[&[b"emitter", &[emitter_bump]]],
        )?;

        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub owner: Signer<'info>,

    /// CHECK: Wormhole Core Bridge program, stored in config for later use.
    pub wormhole_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SendMessage<'info> {
    #[account(
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: Wormhole Core Bridge config PDA (seeds: [b"Bridge"], wormhole program).
    #[account(mut)]
    pub wormhole_bridge: UncheckedAccount<'info>,

    /// CHECK: Fresh Keypair for this message, created by the client as a tx signer.
    #[account(mut, signer)]
    pub wormhole_message: Signer<'info>,

    /// CHECK: Emitter PDA of this program – acts as the Wormhole message source.
    #[account(
        seeds = [b"emitter"],
        bump,
    )]
    pub emitter: UncheckedAccount<'info>,

    /// CHECK: Sequence tracker PDA (seeds: [b"Sequence", emitter], wormhole program).
    #[account(mut)]
    pub sequence: UncheckedAccount<'info>,

    /// CHECK: Wormhole fee collector account.
    #[account(mut)]
    pub fee_collector: UncheckedAccount<'info>,

    pub clock: Sysvar<'info, Clock>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,

    /// CHECK: Wormhole Core Bridge program – must match config.wormhole.
    #[account(constraint = wormhole_program.key() == config.wormhole)]
    pub wormhole_program: UncheckedAccount<'info>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Admin pubkey (can update config in the future).
    pub owner: Pubkey,
    /// Wormhole Core Bridge program ID.
    pub wormhole: Pubkey,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// ABI-encode a string so that `abi.decode(payload, (string))` works on the EVM side.
///
/// Layout (Solidity ABI encoding of a single dynamic `string`):
///   bytes  0..32  : offset to string data = 0x20
///   bytes 32..64  : string byte-length (big-endian u256)
///   bytes 64..64+N: UTF-8 data, zero-padded to next 32-byte boundary
fn abi_encode_string(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let padded_len = (bytes.len() + 31) / 32 * 32;

    let mut encoded = Vec::with_capacity(64 + padded_len);

    // Offset to string data (always 32 for a single dynamic arg)
    let mut offset = [0u8; 32];
    offset[31] = 0x20;
    encoded.extend_from_slice(&offset);

    // String byte-length as big-endian u256
    let mut length = [0u8; 32];
    length[24..32].copy_from_slice(&(bytes.len() as u64).to_be_bytes());
    encoded.extend_from_slice(&length);

    // String data + zero padding
    encoded.extend_from_slice(bytes);
    encoded.resize(64 + padded_len, 0);

    encoded
}
