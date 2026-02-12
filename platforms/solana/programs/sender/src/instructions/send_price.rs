use anchor_lang::prelude::*;

use crate::helpers::abi_encode_price_payload;
use crate::oracle::{compute_usd_price_18dec, read_price};
use crate::{post_wormhole_message, SendPrice};

const ACTION_PRICE_UPDATE: u8 = 1;

pub(crate) fn send_price(ctx: Context<SendPrice>) -> Result<()> {
    let feed = &ctx.accounts.price_feed;

    // 1. Read prices from the Scope oracle account
    let oracle_data = ctx.accounts.scope_prices.try_borrow_data()?;
    let price_entry = read_price(&oracle_data, feed.price_index)?;
    let ref_entry = read_price(&oracle_data, feed.ref_price_index)?;
    drop(oracle_data);

    // 2. Calculate USD price normalised to 18 decimals
    let usd_price = compute_usd_price_18dec(&price_entry, &ref_entry)?;

    // 3. Build payload: (uint8 action, bytes32 assetId, uint256 price, uint64 timestamp)
    let payload = abi_encode_price_payload(
        ACTION_PRICE_UPDATE,
        feed.asset_id,
        usd_price,
        price_entry.unix_timestamp,
    );

    // 4. Post via Wormhole (reuse SendMessage accounts)
    post_wormhole_message(&ctx.accounts.wormhole, ctx.bumps.wormhole.emitter, payload)
}
