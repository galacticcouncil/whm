use anchor_lang::prelude::*;

pub mod helpers;
pub mod instructions;
pub mod oracle;
pub mod stake_pool;
pub mod state;

pub use instructions::initialize::*;
pub use instructions::register_price_feed::*;
pub use instructions::register_pool_feed::*;
pub use instructions::send::*;

declare_id!("3C7vHjyefdDqWqzU2hxwUCFQD9kMiD1SCWWqmEj6HrQG");

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
        scope_prices: Pubkey,
    ) -> Result<()> {
        instructions::register_price_feed::register_price_feed(ctx, asset_id, price_index, scope_prices)
    }

    pub fn register_pool_feed(
        ctx: Context<RegisterPoolFeed>,
        asset_id: [u8; 32],
        stake_pool: Pubkey,
    ) -> Result<()> {
        instructions::register_pool_feed::register_pool_feed(ctx, asset_id, stake_pool)
    }

    pub fn send_message(ctx: Context<SendMessage>, message: String) -> Result<()> {
        instructions::send::send_message(ctx, message)
    }

    pub fn send_price(ctx: Context<SendPrice>) -> Result<()> {
        instructions::send::send_price(ctx)
    }

    pub fn send_rate(ctx: Context<SendRate>) -> Result<()> {
        instructions::send::send_rate(ctx)
    }
}
