use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub owner: Pubkey,
}

/// Owner-created binding between an oracle index, scope oracle account, and an asset identity.
/// Seeds: [b"price_feed", asset_id]
#[account]
#[derive(InitSpace)]
pub struct PriceFeed {
    pub asset_id: [u8; 32],
    pub price_index: u16,
    pub scope_prices: Pubkey,
}

/// Owner-created binding between a stake pool and an asset identity.
/// Seeds: [b"stake_pool_feed", asset_id]
#[account]
#[derive(InitSpace)]
pub struct StakePoolFeed {
    pub asset_id: [u8; 32],
    pub stake_pool: Pubkey,
}
