//! A stand-in for `v1.signer`: `derived_public_key` and `sign` with the live request and response
//! shapes. Each `(predecessor, path)` gets its own Ed25519 key, so derivation stays bound to the
//! caller's account exactly as on mainnet — `sign` takes the runtime's predecessor, never an
//! argument. It signs at once instead of yielding, and the keys are not secret.

use ed25519_dalek::{Signer, SigningKey};
use near_common::mpc::{Payload, SignRequest, SignatureResponse};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockMpc {}

#[near]
impl MockMpc {
    #[init]
    pub fn new() -> Self {
        Self {}
    }

    pub fn derived_public_key(&self, path: String, predecessor: Option<AccountId>, domain_id: Option<u64>) -> String {
        require!(domain_id == Some(1), "Ed25519 only");
        let predecessor = predecessor.unwrap_or_else(env::predecessor_account_id);
        format!("ed25519:{}", bs58::encode(key(&predecessor, &path).verifying_key().to_bytes()).into_string())
    }

    /// Needs 1 yocto, as the live signer does.
    #[payable]
    pub fn sign(&mut self, request: SignRequest) -> SignatureResponse {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "deposit");
        require!(request.domain_id == 1, "Ed25519 only");
        let Payload::Eddsa(payload) = request.payload_v2;
        let payload = hex::decode(payload).unwrap_or_else(|_| env::panic_str("payload"));
        let signature = key(&env::predecessor_account_id(), &request.path).sign(&payload);
        SignatureResponse { scheme: "Ed25519".into(), signature: signature.to_bytes().to_vec() }
    }
}

fn key(predecessor: &AccountId, path: &str) -> SigningKey {
    SigningKey::from_bytes(&env::sha256_array(format!("{predecessor},{path}").as_bytes()))
}
