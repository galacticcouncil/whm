use anchor_lang::prelude::*;

declare_id!("BqbowXrcN2KbKswhBHLZwasFrDh9NV9qpJty7fLH6peJ");

#[program]
pub mod sender {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
