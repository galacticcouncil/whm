use anchor_lang::prelude::*;

pub mod helpers;
pub mod instructions;
pub mod state;

pub use instructions::initialize::*;
pub use instructions::send_message::*;

declare_id!("BqbowXrcN2KbKswhBHLZwasFrDh9NV9qpJty7fLH6peJ");

#[program]
pub mod sender {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::initialize(ctx)
    }

    pub fn send_message(ctx: Context<SendMessage>, message: String) -> Result<()> {
        instructions::send_message::send_message(ctx, message)
    }
}
