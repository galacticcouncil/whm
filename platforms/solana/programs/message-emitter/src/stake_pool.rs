use anchor_lang::prelude::*;

// ── SPL Stake Pool byte layout ──────────────────────────────────────────────
//
//   account_type:            u8       offset   0
//   manager:                 Pubkey   offset   1
//   staker:                  Pubkey   offset  33
//   stake_deposit_authority: Pubkey   offset  65
//   stake_withdraw_bump:     u8       offset  97
//   validator_list:          Pubkey   offset  98
//   reserve_stake:           Pubkey   offset 130
//   pool_mint:               Pubkey   offset 162
//   manager_fee_account:     Pubkey   offset 194
//   token_program_id:        Pubkey   offset 226
//   total_lamports:          u64      offset 258
//   pool_token_supply:       u64      offset 266
//   last_update_epoch:       u64      offset 274

const TOTAL_LAMPORTS_OFFSET: usize = 258;
const POOL_TOKEN_SUPPLY_OFFSET: usize = 266;
const LAST_UPDATE_EPOCH_OFFSET: usize = 274;
const MIN_DATA_LEN: usize = LAST_UPDATE_EPOCH_OFFSET + 8;

#[derive(Clone, Copy, Debug)]
pub struct StakePoolRate {
    pub total_lamports: u64,
    pub pool_token_supply: u64,
    pub last_update_epoch: u64,
}

/// Read total_lamports, pool_token_supply, and last_update_epoch from raw
/// SPL Stake Pool account data.
pub fn read_stake_pool(data: &[u8]) -> Result<StakePoolRate> {
    require!(data.len() >= MIN_DATA_LEN, StakePoolReadError::InvalidData);

    let total_lamports =
        u64::from_le_bytes(data[TOTAL_LAMPORTS_OFFSET..TOTAL_LAMPORTS_OFFSET + 8].try_into().unwrap());
    let pool_token_supply =
        u64::from_le_bytes(data[POOL_TOKEN_SUPPLY_OFFSET..POOL_TOKEN_SUPPLY_OFFSET + 8].try_into().unwrap());
    let last_update_epoch =
        u64::from_le_bytes(data[LAST_UPDATE_EPOCH_OFFSET..LAST_UPDATE_EPOCH_OFFSET + 8].try_into().unwrap());

    Ok(StakePoolRate { total_lamports, pool_token_supply, last_update_epoch })
}

/// Compute pool_token_supply / total_lamports normalised to 18 decimals.
///
/// Example: supply=8832203569191933  lamports=11231388894232904
///          → 786349849… (≈ 0.786349849 × 10^18)
pub fn compute_rate(pool: &StakePoolRate) -> Result<u128> {
    require!(pool.total_lamports > 0, StakePoolReadError::ZeroLamports);

    let supply = pool.pool_token_supply as u128;
    let lamports = pool.total_lamports as u128;

    let rate = supply
        .checked_mul(10u128.pow(18))
        .ok_or(error!(StakePoolReadError::Overflow))?
        / lamports;

    Ok(rate)
}

#[error_code]
pub enum StakePoolReadError {
    #[msg("Stake pool account data too short")]
    InvalidData,
    #[msg("Stake pool total lamports is zero")]
    ZeroLamports,
    #[msg("Arithmetic overflow")]
    Overflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_pool_data(total_lamports: u64, pool_token_supply: u64, last_update_epoch: u64) -> Vec<u8> {
        let mut data = vec![0u8; MIN_DATA_LEN];
        data[TOTAL_LAMPORTS_OFFSET..TOTAL_LAMPORTS_OFFSET + 8]
            .copy_from_slice(&total_lamports.to_le_bytes());
        data[POOL_TOKEN_SUPPLY_OFFSET..POOL_TOKEN_SUPPLY_OFFSET + 8]
            .copy_from_slice(&pool_token_supply.to_le_bytes());
        data[LAST_UPDATE_EPOCH_OFFSET..LAST_UPDATE_EPOCH_OFFSET + 8]
            .copy_from_slice(&last_update_epoch.to_le_bytes());
        data
    }

    fn assert_anchor_error_name(err: anchor_lang::error::Error, expected_name: &str) {
        match err {
            anchor_lang::error::Error::AnchorError(anchor_err) => {
                assert_eq!(anchor_err.error_name, expected_name);
            }
            other => panic!("expected AnchorError, got {other:?}"),
        }
    }

    #[test]
    fn invariant_read_stake_pool_parses_fields() {
        let data = build_pool_data(11231388894232904, 8832203569191933, 952);
        let pool = read_stake_pool(&data).unwrap();
        assert_eq!(pool.total_lamports, 11231388894232904);
        assert_eq!(pool.pool_token_supply, 8832203569191933);
        assert_eq!(pool.last_update_epoch, 952);
    }

    #[test]
    fn invariant_read_stake_pool_rejects_short_data() {
        let data = vec![0u8; MIN_DATA_LEN - 1];
        let err = read_stake_pool(&data).unwrap_err();
        assert_anchor_error_name(err, "InvalidData");
    }

    #[test]
    fn invariant_compute_rate_known_values() {
        let pool = StakePoolRate {
            total_lamports: 11231388894232904,
            pool_token_supply: 8832203569191933,
            last_update_epoch: 952,
        };
        let rate = compute_rate(&pool).unwrap();
        // 8832203569191933 * 10^18 / 11231388894232904 ≈ 786349849…
        // Verify first 4 significant digits
        assert!(rate > 786_000_000_000_000_000);
        assert!(rate < 787_000_000_000_000_000);
    }

    #[test]
    fn invariant_compute_rate_equal_supply_and_lamports() {
        let pool = StakePoolRate {
            total_lamports: 1_000_000_000,
            pool_token_supply: 1_000_000_000,
            last_update_epoch: 0,
        };
        // 1:1 ratio → exactly 10^18
        assert_eq!(compute_rate(&pool).unwrap(), 1_000_000_000_000_000_000);
    }

    #[test]
    fn invariant_compute_rate_zero_lamports_errors() {
        let pool = StakePoolRate {
            total_lamports: 0,
            pool_token_supply: 100,
            last_update_epoch: 0,
        };
        let err = compute_rate(&pool).unwrap_err();
        assert_anchor_error_name(err, "ZeroLamports");
    }
}
