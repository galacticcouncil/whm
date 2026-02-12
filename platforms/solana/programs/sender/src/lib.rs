use anchor_lang::prelude::*;

pub mod helpers;
pub mod instructions;
pub mod oracle;
pub mod state;

pub use instructions::initialize::*;
pub use instructions::register_price_feed::*;
pub use instructions::send_price::SendPrice;
pub use instructions::send_message::SendMessage;

use instructions::send_price::__client_accounts_send_price;
use instructions::send_message::__client_accounts_send_message;

declare_id!("BqbowXrcN2KbKswhBHLZwasFrDh9NV9qpJty7fLH6peJ");

#[program]
pub mod sender {
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
        instructions::send_message::send_message(ctx, message)
    }

    pub fn send_price(ctx: Context<SendPrice>) -> Result<()> {
        instructions::send_price::send_price(ctx)
    }
}
