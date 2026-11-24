//! Base58check, as Zcash's transparent and Bitcoin's legacy addresses spell it: a version, a hash,
//! then the first 4 bytes of `sha256(sha256(version ‖ hash))`.

use near_sdk::env;

/// The payload — version and hash — of a base58check string `len` bytes long. Panics
/// `InvalidAddress` on anything else.
pub fn decode(address: &str, len: usize) -> Vec<u8> {
    let bytes = bs58::decode(address)
        .into_vec()
        .unwrap_or_else(|_| env::panic_str("InvalidAddress"));
    if bytes.len() != len + 4 {
        env::panic_str("InvalidAddress");
    }
    let (payload, checksum) = bytes.split_at(len);
    let digest = env::sha256_array(env::sha256_array(payload));
    if checksum != &digest[..4] {
        env::panic_str("InvalidAddress");
    }
    payload.to_vec()
}

/// `payload` spelled in base58check — what the tests build addresses with.
#[cfg(test)]
pub fn encode(payload: &[u8]) -> String {
    let digest = env::sha256_array(env::sha256_array(payload));
    bs58::encode([payload, &digest[..4]].concat()).into_string()
}
