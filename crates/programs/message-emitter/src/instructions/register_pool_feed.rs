use anchor_lang::prelude::*;

use crate::state::{Config, StakePoolFeed};

#[derive(Accounts)]
#[instruction(asset_id: [u8; 32])]
pub struct RegisterPoolFeed<'info> {
    #[account(seeds = [b"config"], bump, has_one = owner)]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = 8 + StakePoolFeed::INIT_SPACE,
        seeds = [b"stake_pool_feed".as_ref(), asset_id.as_ref()],
        bump,
    )]
    pub stake_pool_feed: Account<'info, StakePoolFeed>,

    pub system_program: Program<'info, System>,
}

pub(crate) fn register_pool_feed(
    ctx: Context<RegisterPoolFeed>,
    asset_id: [u8; 32],
    stake_pool: Pubkey,
) -> Result<()> {
    let feed = &mut ctx.accounts.stake_pool_feed;
    feed.asset_id = asset_id;
    feed.stake_pool = stake_pool;
    Ok(())
}
