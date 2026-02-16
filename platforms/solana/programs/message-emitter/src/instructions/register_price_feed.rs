use anchor_lang::prelude::*;

use crate::state::{Config, PriceFeed};

#[derive(Accounts)]
#[instruction(asset_id: [u8; 32])]
pub struct RegisterPriceFeed<'info> {
    #[account(seeds = [b"config"], bump, has_one = owner)]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + PriceFeed::INIT_SPACE,
        seeds = [b"price_feed".as_ref(), asset_id.as_ref()],
        bump,
    )]
    pub price_feed: Account<'info, PriceFeed>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn register_price_feed(
    ctx: Context<RegisterPriceFeed>,
    asset_id: [u8; 32],
    price_index: u16,
    ref_price_index: u16,
) -> Result<()> {
    let feed = &mut ctx.accounts.price_feed;
    feed.asset_id = asset_id;
    feed.price_index = price_index;
    feed.ref_price_index = ref_price_index;
    Ok(())
}
