//! The price floor, compared exactly: products of a u128 amount, a u128 rate and basis points
//! overflow 256 bits, so both sides are widened to 512 and nothing is divided.

use crate::terms::BPS;

// The macro's own code trips clippy; nothing of ours is inside.
#[allow(clippy::all)]
mod wide {
    uint::construct_uint! {
        pub struct U512(8);
    }
}
pub use wide::U512;

/// 1e18 — rates are destination units per 1e18 wei.
pub const WEI: u128 = 1_000_000_000_000_000_000;

/// `min_out ≥ amount_in × out_per_in × (1 − slippage) / 1e18`, without rounding.
pub fn meets_rate(amount_in: u128, min_out: u128, out_per_in: u128, slippage_bps: u16) -> bool {
    U512::from(min_out) * U512::from(WEI) * U512::from(BPS)
        >= U512::from(amount_in) * U512::from(out_per_in) * U512::from(BPS - slippage_bps)
}

/// `min_out ≥ amount_in × min_out_per_in / 1e18`; a zero hard floor is none.
pub fn meets_hard_floor(amount_in: u128, min_out: u128, min_out_per_in: u128) -> bool {
    U512::from(min_out) * U512::from(WEI) >= U512::from(amount_in) * U512::from(min_out_per_in)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PoC round 1: 0.001 ETH, `minAmountOut` 189133, against 1.8 ZEC/ETH = 180000 units per 1e15.
    #[test]
    fn poc_round() {
        assert!(meets_rate(10u128.pow(15), 189_133, 180_000_000, 0));
        assert!(meets_rate(10u128.pow(15), 180_000, 180_000_000, 0));
        assert!(!meets_rate(10u128.pow(15), 179_999, 180_000_000, 0));
        // 1% below 1.9 ZEC/ETH = 188100.
        assert!(meets_rate(10u128.pow(15), 188_100, 190_000_000, 100));
        assert!(!meets_rate(10u128.pow(15), 188_099, 190_000_000, 100));
    }

    /// wNEAR, 24 decimals: ~1000 NEAR per ETH = 1e27 units per 1e18 wei.
    #[test]
    fn near_decimals() {
        let rate = 1_000 * 10u128.pow(24);
        assert!(meets_rate(WEI, 1_000 * 10u128.pow(24), rate, 0));
        assert!(!meets_rate(WEI, 1_000 * 10u128.pow(24) - 1, rate, 0));
    }

    #[test]
    fn extremes_do_not_overflow() {
        assert!(meets_rate(u128::MAX, u128::MAX, u128::MAX, 0) == (U512::from(WEI) >= U512::from(u128::MAX)));
        assert!(!meets_rate(u128::MAX, 0, u128::MAX, 9_999));
        assert!(!meets_rate(u128::MAX, 0, 1, BPS - 1));
        assert!(meets_rate(0, 0, u128::MAX, 0));
    }

    #[test]
    fn hard_floor() {
        assert!(meets_hard_floor(10u128.pow(15), 150_000, 150_000_000));
        assert!(!meets_hard_floor(10u128.pow(15), 149_999, 150_000_000));
        assert!(meets_hard_floor(u128::MAX, 0, 0));
    }
}
