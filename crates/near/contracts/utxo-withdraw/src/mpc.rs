//! NEAR's MPC signer, `v1.signer`. Keys are derived from `(predecessor, path)` — this contract's
//! account and a path built from the terms — so only this account can get a signature for them.
//!
//! `sign` needs 1 yocto and at least 15 TGas (live config); an Ed25519 payload is raw bytes, hex,
//! and the signature is over those bytes as given.

use near_sdk::{env, ext_contract, near, AccountId};

/// Domain 1 is Ed25519 on mainnet.
pub const DOMAIN_ED25519: u64 = 1;

#[near(serializers = [json])]
pub enum Payload {
    Eddsa(String),
}

#[near(serializers = [json])]
pub struct SignRequest {
    pub path: String,
    pub payload_v2: Payload,
    pub domain_id: u64,
}

/// `SignatureResponse`, tagged by `scheme`. Only the Ed25519 shape is accepted.
#[near(serializers = [json])]
pub struct SignatureResponse {
    pub scheme: String,
    pub signature: Vec<u8>,
}

#[ext_contract(ext_mpc)]
pub trait MpcSigner {
    fn derived_public_key(
        &self,
        path: String,
        predecessor: Option<AccountId>,
        domain_id: Option<u64>,
    ) -> String;
    fn sign(&mut self, request: SignRequest) -> SignatureResponse;
}

/// `"ed25519:<base58>"` → the 32 key bytes.
pub fn parse_ed25519(key: &str) -> [u8; 32] {
    let encoded = key
        .strip_prefix("ed25519:")
        .unwrap_or_else(|| env::panic_str("InvalidDerivedKey"));
    let bytes = bs58::decode(encoded)
        .into_vec()
        .unwrap_or_else(|_| env::panic_str("InvalidDerivedKey"));
    bytes.try_into().unwrap_or_else(|_| env::panic_str("InvalidDerivedKey"))
}

/// A NEAR implicit account is the lowercase hex of its Ed25519 key.
pub fn implicit_account(key: &[u8; 32]) -> AccountId {
    hex::encode(key).parse().unwrap_or_else(|_| env::panic_str("InvalidDerivedKey"))
}

impl SignatureResponse {
    pub fn ed25519(self) -> [u8; 64] {
        if self.scheme != "Ed25519" {
            env::panic_str("UnexpectedSignatureScheme");
        }
        self.signature.try_into().unwrap_or_else(|_| env::panic_str("InvalidSignature"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json;

    #[test]
    fn key_and_account() {
        let key = parse_ed25519(&format!("ed25519:{}", bs58::encode([0xab; 32]).into_string()));
        assert_eq!(key, [0xab; 32]);
        assert_eq!(implicit_account(&key).as_str(), "ab".repeat(32));
    }

    /// Golden vector, live `v1.signer` 2026-10-16: `derived_public_key({ path:
    /// "zcash:v1:t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua", predecessor: "withdraw-zec.hydration-whm.near",
    /// domain_id: 1 })`. The app and the bot must reproduce this `A`.
    #[test]
    fn live_derivation() {
        let key = parse_ed25519("ed25519:FhYNkYjdaYj6tAymcRFyRgH8jQNbW5VARJHtvGdEvD3N");
        assert_eq!(
            implicit_account(&key).as_str(),
            "da66533e90179ebb2e9e546afd4410e36f76e8a8b4ec0376b4e2a8825f802e11"
        );
    }

    #[test]
    #[should_panic(expected = "InvalidDerivedKey")]
    fn secp_key_rejected() {
        parse_ed25519("secp256k1:abc");
    }

    #[test]
    fn request_shape() {
        let request = SignRequest {
            path: "zcash:v1:t1x".into(),
            payload_v2: Payload::Eddsa("00".repeat(32)),
            domain_id: DOMAIN_ED25519,
        };
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            serde_json::json!({ "path": "zcash:v1:t1x", "payload_v2": { "Eddsa": "00".repeat(32) }, "domain_id": 1 })
        );
    }

    #[test]
    fn response_shape() {
        let raw = format!(r#"{{"scheme":"Ed25519","signature":{:?}}}"#, vec![7u8; 64]);
        let response: SignatureResponse = serde_json::from_str(&raw).unwrap();
        assert_eq!(response.ed25519(), [7u8; 64]);
    }
}
