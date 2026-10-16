//! Zcash mainnet, transparent addresses only: base58check `t1…` (P2PKH) and `t3…` (P2SH), and the
//! ZIP-317 fee.

use near_sdk::env;

/// Prefix of every derivation path. A different prefix derives a disjoint set of accounts, so a
/// released one never changes.
pub const PATH_PREFIX: &str = "zcash:v1:";

/// The connector's `get_config().chain`.
pub const CONNECTOR_CHAIN: &str = "ZcashMainnet";

/// ZIP-317 marginal fee, zatoshi per logical action.
pub const ZIP317_MARGINAL_FEE: u128 = 5_000;
/// ZIP-317 grace actions — a transaction pays for at least this many.
pub const ZIP317_GRACE_ACTIONS: u128 = 2;

/// Mainnet transparent address prefixes (base58check version bytes).
const P2PKH: [u8; 2] = [0x1c, 0xb8]; // t1
const P2SH: [u8; 2] = [0x1c, 0xbd]; // t3

/// `t1…` → `OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG`, `t3…` → `OP_HASH160 <20> OP_EQUAL`.
/// Panics `InvalidAddress` on anything else.
pub fn script(address: &str) -> Vec<u8> {
    let (prefix, hash) = decode(address);
    match prefix {
        P2PKH => [&[0x76, 0xa9, 0x14][..], &hash, &[0x88, 0xac]].concat(),
        P2SH => [&[0xa9, 0x14][..], &hash, &[0x87]].concat(),
        _ => env::panic_str("InvalidAddress"),
    }
}

/// ZIP-317: transparent logical actions are the larger of inputs (150 bytes each, standard P2PKH)
/// and output bytes over 34. Every output here is P2PKH (34 bytes) or P2SH (32), so each counts as
/// one.
pub fn miner_fee(inputs: usize, outputs: usize) -> u128 {
    let actions = (inputs.max(outputs) as u128).max(ZIP317_GRACE_ACTIONS);
    ZIP317_MARGINAL_FEE * actions
}

/// Base58check: 2-byte version, 20-byte hash, 4-byte checksum `sha256(sha256(version ‖ hash))`.
fn decode(address: &str) -> ([u8; 2], [u8; 20]) {
    let bytes = bs58::decode(address)
        .into_vec()
        .unwrap_or_else(|_| env::panic_str("InvalidAddress"));
    if bytes.len() != 26 {
        env::panic_str("InvalidAddress");
    }
    let (payload, checksum) = bytes.split_at(22);
    let digest = env::sha256_array(env::sha256_array(payload));
    if checksum != &digest[..4] {
        env::panic_str("InvalidAddress");
    }
    let prefix = [payload[0], payload[1]];
    if prefix != P2PKH && prefix != P2SH {
        env::panic_str("InvalidAddress");
    }
    let mut hash = [0u8; 20];
    hash.copy_from_slice(&payload[2..]);
    (prefix, hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The connector's change address on mainnet, `get_config().change_address`.
    const CHANGE: &str = "t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua";

    #[test]
    fn p2pkh_script() {
        assert_eq!(hex::encode(script(CHANGE)), "76a91413bbd8bc8df03a5a9cda88103f583aa8bc043e2488ac");
    }

    #[test]
    fn p2sh_script() {
        let address = encode(P2SH, [0x11; 20]);
        assert!(address.starts_with("t3"));
        assert_eq!(hex::encode(script(&address)), format!("a914{}87", "11".repeat(20)));
    }

    #[test]
    #[should_panic(expected = "InvalidAddress")]
    fn bad_checksum() {
        let mut address = CHANGE.to_string();
        address.pop();
        address.push('b');
        script(&address);
    }

    #[test]
    #[should_panic(expected = "InvalidAddress")]
    fn testnet_prefix() {
        script(&encode([0x1d, 0x25], [0x11; 20]));
    }

    #[test]
    #[should_panic(expected = "InvalidAddress")]
    fn not_base58() {
        script("t1-not-an-address");
    }

    #[test]
    fn zip317() {
        assert_eq!(miner_fee(1, 1), 10_000);
        assert_eq!(miner_fee(1, 2), 10_000);
        assert_eq!(miner_fee(3, 2), 15_000);
    }

    fn encode(prefix: [u8; 2], hash: [u8; 20]) -> String {
        let payload = [&prefix[..], &hash].concat();
        let digest = env::sha256_array(env::sha256_array(&payload));
        bs58::encode([&payload[..], &digest[..4]].concat()).into_string()
    }
}
