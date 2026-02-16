use anchor_lang::prelude::*;

// ── Scope oracle byte layout (matches Kamino Scope zero_copy structs) ──────

/// Byte size of the Anchor discriminator.
const DISCRIMINATOR_LEN: usize = 8;
/// Byte size of the `oracle_mappings` Pubkey field in OraclePrices.
const HEADER_LEN: usize = 32;
/// Where the prices array starts inside the OraclePrices account.
const PRICES_OFFSET: usize = DISCRIMINATOR_LEN + HEADER_LEN;

/// Size of a single `DatedPrice` entry.
///   Price { value: u64, exp: u64 }  = 16
///   last_updated_slot: u64          =  8
///   unix_timestamp:    u64          =  8
///   generic_data:      [u8; 24]     = 24
///                                   -----
///                                     56
const DATED_PRICE_LEN: usize = 56;

#[derive(Clone, Copy, Debug)]
pub struct ScopePrice {
    pub value: u64,
    pub exp: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct ScopeDatedPrice {
    pub price: ScopePrice,
    pub last_updated_slot: u64,
    pub unix_timestamp: u64,
}

/// Read a `DatedPrice` at `index` from raw Scope OraclePrices account data.
pub fn read_price(data: &[u8], index: u16) -> Result<ScopeDatedPrice> {
    let offset = PRICES_OFFSET + (index as usize) * DATED_PRICE_LEN;
    let end = offset + 32; // we only need the first 32 bytes (4 × u64)

    require!(data.len() >= end, ScopeReadError::OutOfBounds);

    let value = u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap());
    let exp = u64::from_le_bytes(data[offset + 8..offset + 16].try_into().unwrap());
    let last_updated_slot =
        u64::from_le_bytes(data[offset + 16..offset + 24].try_into().unwrap());
    let unix_timestamp =
        u64::from_le_bytes(data[offset + 24..offset + 32].try_into().unwrap());

    Ok(ScopeDatedPrice {
        price: ScopePrice { value, exp },
        last_updated_slot,
        unix_timestamp,
    })
}

/// Calculate a USD price normalised to 18 decimals from a price + reference price.
///
/// Formula:
///   combined_value = price.value × ref_price.value
///   combined_exp   = price.exp + ref_price.exp
///   result         = combined_value × 10^(18 - combined_exp)
pub fn compute_usd_price_18dec(
    price: &ScopeDatedPrice,
    ref_price: &ScopeDatedPrice,
) -> Result<u128> {
    let combined_value = (price.price.value as u128)
        .checked_mul(ref_price.price.value as u128)
        .ok_or(error!(ScopeReadError::Overflow))?;

    let combined_exp = price.price.exp + ref_price.price.exp;

    // We want the result in 18 decimals.
    // result = combined_value * 10^(18 - combined_exp)   if 18 >= combined_exp
    // result = combined_value / 10^(combined_exp - 18)   if combined_exp > 18
    let result = if combined_exp <= 18 {
        let scale = 10u128.pow((18 - combined_exp) as u32);
        combined_value
            .checked_mul(scale)
            .ok_or(error!(ScopeReadError::Overflow))?
    } else {
        let scale = 10u128.pow((combined_exp - 18) as u32);
        combined_value / scale
    };

    Ok(result)
}

#[error_code]
pub enum ScopeReadError {
    #[msg("Price index out of bounds")]
    OutOfBounds,
    #[msg("Arithmetic overflow")]
    Overflow,
}
