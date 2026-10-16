//! Zcash, transparent addresses only: base58check P2PKH and P2SH (`t1`/`t3` on mainnet, `tm`/`t2` on
//! testnet), and the ZIP-317 fee.

use near_sdk::env;

/// ZIP-317 marginal fee, zatoshi per logical action.
pub const ZIP317_MARGINAL_FEE: u128 = 5_000;
/// ZIP-317 grace actions — a transaction pays for at least this many.
pub const ZIP317_GRACE_ACTIONS: u128 = 2;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Network {
    Mainnet,
    Testnet,
}

impl Network {
    /// Prefix of every derivation path. A different prefix derives a disjoint set of accounts, so a
    /// released one never changes.
    pub fn path_prefix(self) -> &'static str {
        match self {
            Network::Mainnet => "zcash:v1:",
            Network::Testnet => "zcash-testnet:v1:",
        }
    }

    /// The connector's `get_config().chain`.
    pub fn connector_chain(self) -> &'static str {
        match self {
            Network::Mainnet => "ZcashMainnet",
            Network::Testnet => "ZcashTestnet",
        }
    }

    /// Base58check version bytes: (P2PKH, P2SH).
    fn prefixes(self) -> ([u8; 2], [u8; 2]) {
        match self {
            Network::Mainnet => ([0x1c, 0xb8], [0x1c, 0xbd]), // t1, t3
            Network::Testnet => ([0x1d, 0x25], [0x1c, 0xba]), // tm, t2
        }
    }
}

/// P2PKH → `OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG`, P2SH → `OP_HASH160 <20> OP_EQUAL`.
/// Panics `InvalidAddress` on anything else, including the other network's addresses.
pub fn script(network: Network, address: &str) -> Vec<u8> {
    let (p2pkh, p2sh) = network.prefixes();
    let (prefix, hash) = decode(address);
    if prefix == p2pkh {
        [&[0x76, 0xa9, 0x14][..], &hash, &[0x88, 0xac]].concat()
    } else if prefix == p2sh {
        [&[0xa9, 0x14][..], &hash, &[0x87]].concat()
    } else {
        env::panic_str("InvalidAddress")
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
    let mut hash = [0u8; 20];
    hash.copy_from_slice(&payload[2..]);
    ([payload[0], payload[1]], hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The connectors' change addresses, `get_config().change_address`.
    const MAINNET_CHANGE: &str = "t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua";
    const TESTNET_CHANGE: &str = "tmQxGEDYQX7G71sG2KbTCvE6EMmj9zVEw2B";

    #[test]
    fn p2pkh_script() {
        assert_eq!(
            hex::encode(script(Network::Mainnet, MAINNET_CHANGE)),
            "76a91413bbd8bc8df03a5a9cda88103f583aa8bc043e2488ac"
        );
    }

    #[test]
    fn p2sh_script() {
        let address = encode([0x1c, 0xbd], [0x11; 20]);
        assert!(address.starts_with("t3"));
        assert_eq!(hex::encode(script(Network::Mainnet, &address)), format!("a914{}87", "11".repeat(20)));
    }

    #[test]
    fn testnet_addresses() {
        assert!(hex::encode(script(Network::Testnet, TESTNET_CHANGE)).starts_with("76a914"));
        let p2sh = encode([0x1c, 0xba], [0x22; 20]);
        assert!(p2sh.starts_with("t2"));
        assert_eq!(hex::encode(script(Network::Testnet, &p2sh)), format!("a914{}87", "22".repeat(20)));
    }

    #[test]
    #[should_panic(expected = "InvalidAddress")]
    fn mainnet_rejects_testnet() {
        script(Network::Mainnet, TESTNET_CHANGE);
    }

    #[test]
    #[should_panic(expected = "InvalidAddress")]
    fn testnet_rejects_mainnet() {
        script(Network::Testnet, MAINNET_CHANGE);
    }

    #[test]
    #[should_panic(expected = "InvalidAddress")]
    fn bad_checksum() {
        let mut address = MAINNET_CHANGE.to_string();
        address.pop();
        address.push('b');
        script(Network::Mainnet, &address);
    }

    #[test]
    #[should_panic(expected = "InvalidAddress")]
    fn not_base58() {
        script(Network::Mainnet, "t1-not-an-address");
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
