use anchor_lang::prelude::*;

pub mod helpers;
pub mod instructions;
pub mod oracle;
pub mod state;

pub use instructions::initialize::*;
pub use instructions::register_price_feed::*;
pub use instructions::send::*;

declare_id!("8KL6xhNL9mUVLSurKsB1jNiwgH4ifLk3gPtC5PccavNt");

#[program]
pub mod message_emitter {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::initialize(ctx)
    }

    pub fn register_price_feed(
        ctx: Context<RegisterPriceFeed>,
        asset_id: [u8; 32],
        price_index: u16,
        ref_price_index: u16,
    ) -> Result<()> {
        instructions::register_price_feed::register_price_feed(
            ctx,
            asset_id,
            price_index,
            ref_price_index,
        )
    }

    pub fn send_message(ctx: Context<SendMessage>, message: String) -> Result<()> {
        instructions::send::send_message(ctx, message)
    }

    pub fn send_price(ctx: Context<SendPrice>) -> Result<()> {
        instructions::send::send_price(ctx)
    }
}
