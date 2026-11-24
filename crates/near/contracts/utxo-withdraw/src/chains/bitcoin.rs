//! Bitcoin mainnet: base58check P2PKH (`1…`) and P2SH (`3…`), SegWit v0 P2WPKH and P2WSH (`bc1q…`,
//! bech32) and Taproot (`bc1p…`, bech32m).
//!
//! Lowercase only: the address string is the derivation path, so one address has one spelling and
//! one `A`.
//!
//! The miner fee is a rate times an upper bound on the transaction's size. The owner sets the rate;
//! no caller names it, so none can make a user overpay. Above the rate a withdrawal waits in the
//! mempool until fees fall — delayed, not lost — so the relayer withdraws only while the mempool is
//! at or under it.

use near_sdk::env;

use super::base58check;

/// Base58check versions.
const P2PKH: u8 = 0x00;
const P2SH: u8 = 0x05;

/// What every mainnet SegWit address starts with: the human-readable part and the separator.
const SEGWIT_PREFIX: &str = "bc1";
const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
/// The checksum constants: bech32 for witness version 0, bech32m for 1 and up (BIP-350).
const BECH32: u32 = 1;
const BECH32M: u32 = 0x2bc8_30a3;
/// BIP-173's limit on a whole address.
const MAX_LENGTH: usize = 90;

/// Prefix of every derivation path.
pub const PATH_PREFIX: &str = "bitcoin:v1:";
/// The connector's `get_config().chain`.
pub const CONNECTOR_CHAIN: &str = "BitcoinMainnet";

/// Sats per virtual byte until the owner sets a rate: 825 sat a withdrawal.
pub const DEFAULT_FEE_RATE: u64 = 5;
/// The highest rate the owner may set: 30 × 165 vB = 4,950 sat, under the connector's 5,000 cap.
pub const MAX_FEE_RATE: u64 = 30;
/// Virtual bytes: the version, locktime, counts and SegWit marker, rounded up; one P2WPKH input —
/// the connector's coins; one output of the largest standard kind (P2WSH, P2TR).
const VSIZE_BASE: u128 = 11;
const VSIZE_INPUT: u128 = 68;
const VSIZE_OUTPUT: u128 = 43;

/// The miner fee, at `fee_rate` sat/vB, of a transaction spending `inputs` coins into `outputs`
/// outputs.
pub fn miner_fee(fee_rate: u64, inputs: usize, outputs: usize) -> u128 {
    u128::from(fee_rate) * (VSIZE_BASE + VSIZE_INPUT * inputs as u128 + VSIZE_OUTPUT * outputs as u128)
}

/// The output script paying `address`. Panics `InvalidAddress` on anything else, including testnet
/// addresses, uppercase SegWit and witness versions past Taproot.
pub fn script(address: &str) -> Vec<u8> {
    if let Some(data) = address.strip_prefix(SEGWIT_PREFIX) {
        return segwit(address, data);
    }
    let payload = base58check::decode(address, 21);
    match payload[0] {
        P2PKH => [&[0x76, 0xa9, 0x14][..], &payload[1..], &[0x88, 0xac]].concat(),
        P2SH => [&[0xa9, 0x14][..], &payload[1..], &[0x87]].concat(),
        _ => env::panic_str("InvalidAddress"),
    }
}

/// `OP_0 <20|32>` for version 0 under bech32, `OP_1 <32>` for Taproot under bech32m.
fn segwit(address: &str, data: &str) -> Vec<u8> {
    if address.len() > MAX_LENGTH || data.len() < 7 {
        env::panic_str("InvalidAddress");
    }
    let values: Vec<u8> = data
        .bytes()
        .map(|c| CHARSET.iter().position(|&x| x == c).unwrap_or_else(|| env::panic_str("InvalidAddress")) as u8)
        .collect();
    // The checksum covers the expanded human-readable part `bc`, then every value.
    let mut checked = vec![b'b' >> 5, b'c' >> 5, 0, b'b' & 31, b'c' & 31];
    checked.extend_from_slice(&values);
    let constant = polymod(&checked);
    let program = to_bytes(&values[1..values.len() - 6]);
    match (values[0], constant, program.len()) {
        (0, BECH32, 20 | 32) => [&[0x00, program.len() as u8][..], &program].concat(),
        (1, BECH32M, 32) => [&[0x51, 0x20][..], &program].concat(),
        _ => env::panic_str("InvalidAddress"),
    }
}

/// BIP-173's checksum polynomial.
fn polymod(values: &[u8]) -> u32 {
    const GEN: [u32; 5] = [0x3b6a_57b2, 0x2650_8e6d, 0x1ea1_19fa, 0x3d42_33dd, 0x2a14_62b3];
    let mut chk: u32 = 1;
    for &v in values {
        let top = chk >> 25;
        chk = ((chk & 0x1ff_ffff) << 5) ^ u32::from(v);
        for (i, g) in GEN.iter().enumerate() {
            if (top >> i) & 1 == 1 {
                chk ^= g;
            }
        }
    }
    chk
}

/// 5-bit groups to bytes; the leftover padding must be under 5 bits and zero.
fn to_bytes(values: &[u8]) -> Vec<u8> {
    let (mut acc, mut bits, mut out) = (0u32, 0u32, Vec::new());
    for &v in values {
        acc = (acc << 5) | u32::from(v);
        bits += 5;
        while bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
        acc &= (1 << bits) - 1;
    }
    if bits >= 5 || acc != 0 {
        env::panic_str("InvalidAddress");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Omni's Bitcoin connector's `get_config().change_address`.
    pub const CHANGE: &str = "bc1qp42j7hn3lup7gck6y6eks6x2lmnp800t6gy7sk";

    fn hex_script(address: &str) -> String {
        hex::encode(script(address))
    }

    #[test]
    fn legacy_scripts() {
        assert_eq!(hex_script("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"), "76a91477bff20c60e522dfaa3350c39b030a5d004e839a88ac");
        assert_eq!(hex_script("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy"), "a914b472a266d0bd89c13706a4132ccfb16f7c3b9fcb87");
    }

    /// BIP-173 and BIP-350 vectors, and the connector's own change address.
    #[test]
    fn segwit_scripts() {
        assert_eq!(hex_script("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"), "0014751e76e8199196d454941c45d1b3a323f1433bd6");
        assert_eq!(
            hex_script("bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3"),
            "00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262"
        );
        assert_eq!(
            hex_script("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"),
            "512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
        );
        assert_eq!(hex_script(CHANGE), "00140d552f5e71ff03e462da26b36868cafee613bdeb");
    }

    fn rejects(address: &str) {
        let result = std::panic::catch_unwind(|| script(address));
        assert!(result.is_err(), "accepted {address}");
    }

    /// One coin in, the user and change out: 165 vB — 825 sat at the default rate, 4,950 at the
    /// highest, both inside the connector's 100..=5000.
    #[test]
    fn fee_by_rate() {
        assert_eq!(miner_fee(DEFAULT_FEE_RATE, 1, 2), 825);
        assert_eq!(miner_fee(DEFAULT_FEE_RATE, 1, 1), 610);
        assert_eq!(miner_fee(MAX_FEE_RATE, 1, 2), 4_950);
        assert_eq!(miner_fee(1, 1, 2), 165);
    }

    #[test]
    fn refusals() {
        // Taproot under bech32's checksum, and a version past Taproot (valid bech32m, BIP-350).
        rejects("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd");
        rejects("bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs");
        // One character changed, uppercase, testnet, nothing after the prefix.
        rejects("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5");
        rejects("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4");
        rejects("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");
        rejects("bc1");
        // Base58: a changed character, Zcash's two-byte version, a testnet P2PKH.
        rejects("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3");
        rejects("t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua");
        rejects(&base58check::encode(&[&[0x6f][..], &[0x11; 20]].concat()));
    }
}
