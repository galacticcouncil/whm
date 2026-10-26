//! What `intents.near` verifies (v0.4.5, 16d04f6): a NEP-413 envelope over a JSON message, with a
//! versioned nonce.
//!
//! ```text
//! digest = sha256( LE_u32(2^31 + 413) ‖ borsh({ message, nonce, recipient, callback_url: None }) )
//! nonce  = 5628f6c6 ‖ 0x00 ‖ salt 4 ‖ expiry i64 ns LE ‖ entropy 15
//! ```
//!
//! The digest is signed once, never hashed again. A payload's deadline must not be after its
//! nonce's expiry.

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, AccountId};

use near_common::time;

/// NEP-413's prefix tag, 2^31 + 413.
pub const NEP413_TAG: u32 = (1 << 31) + 413;

/// `VersionedNonce::VERSIONED_MAGIC_PREFIX`.
pub const NONCE_MAGIC: [u8; 4] = [0x56, 0x28, 0xf6, 0xc6];

/// Separates this router's nonces from any other signer's. Bump it on a rail migration: a new
/// `seq` namespace must not reproduce an old nonce.
pub const NONCE_DOMAIN: &[u8] = b"whm-intent-router/v1";

/// The versioned nonce: unusable after `expiry_ms`, and identical whenever its inputs are.
pub fn versioned_nonce(salt: [u8; 4], expiry_ms: u64, entropy: [u8; 15]) -> [u8; 32] {
    let mut nonce = [0u8; 32];
    nonce[..4].copy_from_slice(&NONCE_MAGIC);
    nonce[5..9].copy_from_slice(&salt);
    let expiry_ns = i64::try_from(u128::from(expiry_ms) * 1_000_000).unwrap_or(i64::MAX);
    nonce[9..17].copy_from_slice(&expiry_ns.to_le_bytes());
    nonce[17..].copy_from_slice(&entropy);
    nonce
}

/// `sha256(NONCE_DOMAIN ‖ parts…)`, first 15 bytes.
pub fn entropy(parts: &[&[u8]]) -> [u8; 15] {
    let mut preimage = NONCE_DOMAIN.to_vec();
    for part in parts {
        preimage.extend_from_slice(part);
    }
    env::sha256_array(&preimage)[..15].try_into().unwrap()
}

/// The 32 bytes `A`'s key signs.
pub fn nep413_digest(message: &str, nonce: &[u8; 32], recipient: &str) -> [u8; 32] {
    let mut bytes = NEP413_TAG.to_le_bytes().to_vec();
    borsh_string(&mut bytes, message);
    bytes.extend_from_slice(nonce);
    borsh_string(&mut bytes, recipient);
    bytes.push(0); // callback_url: None
    env::sha256_array(&bytes)
}

fn borsh_string(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

/// The intents message, as the JSON string that is signed.
pub fn message(signer: &AccountId, deadline_ms: u64, intents: Vec<Value>) -> String {
    json!({ "signer_id": signer, "deadline": time::format(deadline_ms), "intents": intents }).to_string()
}

/// Moves `amount` of `token` (a ledger id) to `receiver`'s intents account.
pub fn transfer(receiver: &str, token: &str, amount: u128) -> Value {
    json!({ "intent": "transfer", "receiver_id": receiver, "tokens": { token: U128(amount) } })
}

/// Withdraws `amount` of the NEP-141 `token` out of `intents.near` to `receiver`.
pub fn ft_withdraw(token: &str, receiver: &str, amount: u128, memo: Option<String>) -> Value {
    let mut intent = json!({ "intent": "ft_withdraw", "token": token, "receiver_id": receiver, "amount": U128(amount) });
    if let Some(memo) = memo {
        intent["memo"] = Value::from(memo);
    }
    intent
}

/// The `MultiPayload` the relay and 1Click take.
pub fn multi_payload(message: &str, nonce: &[u8; 32], recipient: &str, key: &[u8; 32], signature: &[u8; 64]) -> Value {
    json!({
        "standard": "nep413",
        "payload": { "recipient": recipient, "nonce": Base64VecU8(nonce.to_vec()), "message": message },
        "public_key": format!("ed25519:{}", bs58::encode(key).into_string()),
        "signature": format!("ed25519:{}", bs58::encode(signature).into_string()),
    })
}

/// An EVM address with its EIP-55 checksum.
pub fn eip55(address: &[u8; 20]) -> String {
    let lower = hex::encode(address);
    let hash = env::keccak256_array(lower.as_bytes());
    let mixed: String = lower
        .chars()
        .enumerate()
        .map(|(i, c)| {
            let nibble = (hash[i / 2] >> (if i % 2 == 0 { 4 } else { 0 })) & 0xf;
            if nibble >= 8 { c.to_ascii_uppercase() } else { c }
        })
        .collect();
    format!("0x{mixed}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json;

    /// From the PoC's TypeScript — the encoding `intents.near` accepted on mainnet: the nonce for
    /// salt `a1b2c3d4`, expiry 1_793_000_000_123 ms and entropy `07` × 15, and the NEP-413 digest of
    /// `{"signer_id":"ab…ab","deadline":"2026-10-25T12:00:00.000Z","intents":[]}` under it.
    #[test]
    fn matches_the_poc() {
        let nonce = versioned_nonce([0xa1, 0xb2, 0xc3, 0xd4], 1_793_000_000_123, [7; 15]);
        assert_eq!(hex::encode(nonce), "5628f6c600a1b2c3d4c0549b190004e218070707070707070707070707070707");

        let message = format!(r#"{{"signer_id":"{}","deadline":"2026-10-25T12:00:00.000Z","intents":[]}}"#, "ab".repeat(32));
        assert_eq!(
            hex::encode(nep413_digest(&message, &nonce, "intents.near")),
            "db1b9a8cbf575443b6ecef35cdd0a7cff03d78b60c4ca180d8a3448205fbbace"
        );
    }

    #[test]
    fn entropy_depends_on_every_part() {
        let a = entropy(&[b"swap", &[1; 32], &5u64.to_be_bytes()]);
        assert_eq!(a, entropy(&[b"swap", &[1; 32], &5u64.to_be_bytes()]));
        assert_ne!(a, entropy(&[b"swap", &[1; 32], &6u64.to_be_bytes()]));
        assert_ne!(a, entropy(&[b"swap", &[2; 32], &5u64.to_be_bytes()]));
    }

    #[test]
    fn intents_shapes() {
        assert_eq!(
            transfer("dep.near", "nep141:eth.omft.near", 5),
            serde_json::json!({ "intent": "transfer", "receiver_id": "dep.near", "tokens": { "nep141:eth.omft.near": "5" } })
        );
        assert_eq!(
            ft_withdraw("zec.omft.near", "zec.omft.near", 7, Some("WITHDRAW_TO:t1x".into())),
            serde_json::json!({ "intent": "ft_withdraw", "token": "zec.omft.near", "receiver_id": "zec.omft.near", "amount": "7", "memo": "WITHDRAW_TO:t1x" })
        );
        let m: Value = serde_json::from_str(&message(&"ab".repeat(32).parse().unwrap(), 0, vec![])).unwrap();
        assert_eq!(m["deadline"], "1970-01-01T00:00:00.000Z");
    }

    /// EIP-55's own test vector.
    #[test]
    fn checksum() {
        let a: [u8; 20] = hex::decode("5aaeb6053f3e94c9b9a09f33669435e7ef1beaed").unwrap().try_into().unwrap();
        assert_eq!(eip55(&a), "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    }
}
