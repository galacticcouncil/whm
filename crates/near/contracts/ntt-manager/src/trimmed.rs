//! `TrimmedAmount` — NTT carries amounts at no more than 8 decimals so every runtime fits them in a
//! `u64`. Semantics follow `TrimmedAmount.sol`: trim to `min(8, from, to)`, scale down by truncation.

use near_sdk::near;

/// NTT's wire precision ceiling.
pub const TRIMMED_DECIMALS: u8 = 8;

#[near(serializers = [borsh])]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrimmedAmount {
    pub amount: u64,
    pub decimals: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrimError {
    /// The scaled amount does not fit a `u64` — `AmountTooLarge` on EVM.
    AmountTooLarge,
}

impl TrimmedAmount {
    /// Trims `amount` (at `from_decimals`) for a peer at `to_decimals`.
    ///
    /// Returns the trimmed amount and the dust — what `untrim` cannot give back. The caller refunds
    /// the dust rather than locking it.
    pub fn trim(amount: u128, from_decimals: u8, to_decimals: u8) -> Result<(Self, u128), TrimError> {
        let decimals = TRIMMED_DECIMALS.min(to_decimals).min(from_decimals);
        let scaled = scale(amount, from_decimals, decimals);
        let trimmed = Self {
            amount: u64::try_from(scaled).map_err(|_| TrimError::AmountTooLarge)?,
            decimals,
        };
        let dust = amount - trimmed.untrim(from_decimals);
        Ok((trimmed, dust))
    }

    /// Scales back up to `to_decimals`.
    pub fn untrim(&self, to_decimals: u8) -> u128 {
        scale(self.amount as u128, self.decimals, to_decimals)
    }
}

/// Rescales between precisions: truncates going down, multiplies going up.
fn scale(amount: u128, from_decimals: u8, to_decimals: u8) -> u128 {
    if from_decimals == to_decimals {
        amount
    } else if from_decimals > to_decimals {
        amount / 10u128.pow((from_decimals - to_decimals) as u32)
    } else {
        amount * 10u128.pow((to_decimals - from_decimals) as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zec_is_exact() {
        // 8 dp on NEAR, 8 on the wire — nothing to trim.
        let (t, dust) = TrimmedAmount::trim(123_456_789, 8, 8).unwrap();
        assert_eq!(t, TrimmedAmount { amount: 123_456_789, decimals: 8 });
        assert_eq!(dust, 0);
        assert_eq!(t.untrim(8), 123_456_789);
    }

    #[test]
    fn near_trims_24_to_8_and_returns_dust() {
        // 1.5 NEAR + 1 yocto.
        let amount = 1_500_000_000_000_000_000_000_001u128;
        let (t, dust) = TrimmedAmount::trim(amount, 24, 18).unwrap();
        assert_eq!(t, TrimmedAmount { amount: 150_000_000, decimals: 8 });
        assert_eq!(dust, 1);
        assert_eq!(t.untrim(24) + dust, amount);
    }

    #[test]
    fn peer_below_eight_decimals_wins() {
        let (t, dust) = TrimmedAmount::trim(1_234_567_890_123, 8, 6).unwrap();
        assert_eq!(t, TrimmedAmount { amount: 12_345_678_901, decimals: 6 });
        assert_eq!(dust, 23);
    }

    #[test]
    fn overflow_is_rejected() {
        let amount = (u64::MAX as u128 + 1) * 10u128.pow(16);
        assert_eq!(TrimmedAmount::trim(amount, 24, 18), Err(TrimError::AmountTooLarge));
    }

    #[test]
    fn inbound_untrim_scales_up() {
        // 8-decimal wire amount into a 24-decimal token.
        let t = TrimmedAmount { amount: 150_000_000, decimals: 8 };
        assert_eq!(t.untrim(24), 1_500_000_000_000_000_000_000_000);
    }
}
