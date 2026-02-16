use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub owner: Pubkey,
}

/// Owner-created binding between an oracle index and an asset identity.
/// Seeds: [b"price_feed", asset_id]
#[account]
#[derive(InitSpace)]
pub struct PriceFeed {
    pub asset_id: [u8; 32],
    pub price_index: u16,
}
