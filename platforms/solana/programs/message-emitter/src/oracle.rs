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
    let last_updated_slot = u64::from_le_bytes(data[offset + 16..offset + 24].try_into().unwrap());
    let unix_timestamp = u64::from_le_bytes(data[offset + 24..offset + 32].try_into().unwrap());

    Ok(ScopeDatedPrice {
        price: ScopePrice { value, exp },
        last_updated_slot,
        unix_timestamp,
    })
}

/// Normalise a Scope oracle price to 18 decimals.
///
/// Formula:
///   result = value × 10^(18 - exp)   if exp <= 18
///   result = value / 10^(exp - 18)   if exp  > 18
pub fn normalize_to_18dec(price: &ScopeDatedPrice) -> Result<u128> {
    let value = price.price.value as u128;
    let exp = price.price.exp;

    let result = if exp <= 18 {
        let scale = 10u128.pow((18 - exp) as u32);
        value
            .checked_mul(scale)
            .ok_or(error!(ScopeReadError::Overflow))?
    } else {
        let downscale_exp = exp - 18;
        if downscale_exp >= 39 {
            return Err(error!(ScopeReadError::Overflow));
        } else {
            let scale = 10u128.pow(downscale_exp as u32);
            value / scale
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_anchor_error_name(err: anchor_lang::error::Error, expected_name: &str) {
        match err {
            anchor_lang::error::Error::AnchorError(anchor_err) => {
                assert_eq!(anchor_err.error_name, expected_name);
            }
            other => panic!("expected AnchorError, got {other:?}"),
        }
    }

    fn make_price(
        value: u64,
        exp: u64,
        last_updated_slot: u64,
        unix_timestamp: u64,
    ) -> ScopeDatedPrice {
        ScopeDatedPrice {
            price: ScopePrice { value, exp },
            last_updated_slot,
            unix_timestamp,
        }
    }

    fn build_oracle_data(entries: &[(u64, u64, u64, u64)]) -> Vec<u8> {
        let mut data = vec![0u8; PRICES_OFFSET + entries.len() * DATED_PRICE_LEN];
        for (index, (value, exp, slot, timestamp)) in entries.iter().enumerate() {
            let start = PRICES_OFFSET + index * DATED_PRICE_LEN;
            data[start..start + 8].copy_from_slice(&value.to_le_bytes());
            data[start + 8..start + 16].copy_from_slice(&exp.to_le_bytes());
            data[start + 16..start + 24].copy_from_slice(&slot.to_le_bytes());
            data[start + 24..start + 32].copy_from_slice(&timestamp.to_le_bytes());
            data[start + 32..start + DATED_PRICE_LEN].fill(0xAB);
        }
        data
    }

    #[test]
    fn invariant_read_price_reads_selected_entry() {
        let data = build_oracle_data(&[(11, 2, 101, 1001), (22, 3, 202, 2002), (33, 4, 303, 3003)]);

        let parsed = read_price(&data, 1).unwrap();
        assert_eq!(parsed.price.value, 22);
        assert_eq!(parsed.price.exp, 3);
        assert_eq!(parsed.last_updated_slot, 202);
        assert_eq!(parsed.unix_timestamp, 2002);
    }

    #[test]
    fn invariant_read_price_out_of_bounds_errors() {
        let data = build_oracle_data(&[(7, 8, 9, 10)]);
        let err = read_price(&data, 1).unwrap_err();
        assert_anchor_error_name(err, "OutOfBounds");
    }

    #[test]
    fn invariant_normalize_upscales_correctly() {
        // value=123, exp=2 → 123 * 10^16 = 1_230_000_000_000_000_000
        let p = make_price(123, 2, 0, 0);
        assert_eq!(normalize_to_18dec(&p).unwrap(), 1_230_000_000_000_000_000u128);
    }

    #[test]
    fn invariant_normalize_downscales_correctly() {
        // value=101923944434509490, exp=17 → 101923944434509490 * 10^1 = 1_019_239_444_345_094_900
        let p = make_price(101_923_944_434_509_490, 17, 0, 0);
        assert_eq!(normalize_to_18dec(&p).unwrap(), 1_019_239_444_345_094_900u128);
    }

    #[test]
    fn invariant_normalize_exact_18_exp() {
        // exp=18 → no scaling, value returned as-is
        let p = make_price(1234, 18, 0, 0);
        assert_eq!(normalize_to_18dec(&p).unwrap(), 1234u128);
    }

    #[test]
    fn invariant_normalize_exp_above_18() {
        // value=999_000, exp=20 → 999_000 / 10^2 = 9_990
        let p = make_price(999_000, 20, 0, 0);
        assert_eq!(normalize_to_18dec(&p).unwrap(), 9_990u128);
    }

    #[test]
    fn invariant_normalize_huge_exponent_returns_error() {
        let p = make_price(42, 100, 0, 0);
        let err = normalize_to_18dec(&p).unwrap_err();
        assert_anchor_error_name(err, "Overflow");
    }
}
