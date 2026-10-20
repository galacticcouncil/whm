//! NEP-366 meta-transactions, encoded by hand to nearcore's borsh layout.
//!
//! ```text
//! DelegateAction        sender_id, receiver_id, actions: Vec<Action>, nonce u64, max_block_height u64,
//!                       public_key (0 = ED25519 ‖ 32)
//! Action::FunctionCall  2 ‖ method_name ‖ args ‖ gas u64 ‖ deposit u128
//! SignableMessage       LE u32 (2³⁰ + 366) ‖ DelegateAction      → sha256 is what the key signs
//! SignedDelegateAction  DelegateAction ‖ signature (0 = ED25519 ‖ 64)
//! ```
//!
//! Strings and byte vectors are `LE u32 length ‖ bytes`; integers little-endian. Cross-checked
//! against `near-primitives` in the sandbox crate.

use near_sdk::{env, AccountId, Gas, NearToken};

/// NEP-461 on-chain discriminant for NEP-366.
pub const DELEGATE_DISCRIMINANT: u32 = (1 << 30) + 366;

/// Runtime nonces are `block_height × ACCESS_KEY_NONCE_RANGE_MULTIPLIER`-scaled.
pub const NONCE_MULTIPLIER: u64 = 1_000_000;

const ACTION_FUNCTION_CALL: u8 = 2;
const KEY_ED25519: u8 = 0;

/// A delegate action with one function call — the only kind this contract signs.
pub struct Delegate {
    pub sender_id: AccountId,
    pub receiver_id: AccountId,
    pub method_name: &'static str,
    pub args: Vec<u8>,
    pub gas: Gas,
    pub deposit: NearToken,
    pub nonce: u64,
    pub max_block_height: u64,
    pub public_key: [u8; 32],
}

impl Delegate {
    /// Borsh of the `DelegateAction`.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(256 + self.args.len());
        write_bytes(&mut out, self.sender_id.as_bytes());
        write_bytes(&mut out, self.receiver_id.as_bytes());
        out.extend_from_slice(&1u32.to_le_bytes());
        out.push(ACTION_FUNCTION_CALL);
        write_bytes(&mut out, self.method_name.as_bytes());
        write_bytes(&mut out, &self.args);
        out.extend_from_slice(&self.gas.as_gas().to_le_bytes());
        out.extend_from_slice(&self.deposit.as_yoctonear().to_le_bytes());
        out.extend_from_slice(&self.nonce.to_le_bytes());
        out.extend_from_slice(&self.max_block_height.to_le_bytes());
        out.push(KEY_ED25519);
        out.extend_from_slice(&self.public_key);
        out
    }
}

/// The 32 bytes the delegate's key signs: `sha256(borsh(SignableMessage))`.
pub fn signing_hash(delegate: &[u8]) -> [u8; 32] {
    let mut message = Vec::with_capacity(4 + delegate.len());
    message.extend_from_slice(&DELEGATE_DISCRIMINANT.to_le_bytes());
    message.extend_from_slice(delegate);
    env::sha256_array(&message)
}

/// Borsh of the `SignedDelegateAction` — what goes into a relayer's `Action::Delegate`.
pub fn signed(delegate: &[u8], signature: &[u8; 64]) -> Vec<u8> {
    let mut out = Vec::with_capacity(delegate.len() + 65);
    out.extend_from_slice(delegate);
    out.push(KEY_ED25519);
    out.extend_from_slice(signature);
    out
}

fn write_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(bytes);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout() {
        let d = Delegate {
            sender_id: "a.near".parse().unwrap(),
            receiver_id: "b.near".parse().unwrap(),
            method_name: "m",
            args: vec![0xaa],
            gas: Gas::from_gas(7),
            deposit: NearToken::from_yoctonear(1),
            nonce: 9,
            max_block_height: 10,
            public_key: [0x55; 32],
        };
        let expected = [
            &6u32.to_le_bytes()[..], b"a.near",
            &6u32.to_le_bytes(), b"b.near",
            &1u32.to_le_bytes(), &[2],
            &1u32.to_le_bytes(), b"m",
            &1u32.to_le_bytes(), &[0xaa],
            &7u64.to_le_bytes(), &1u128.to_le_bytes(),
            &9u64.to_le_bytes(), &10u64.to_le_bytes(),
            &[0], &[0x55; 32],
        ]
        .concat();
        assert_eq!(d.encode(), expected);
    }

    #[test]
    fn discriminant() {
        assert_eq!(DELEGATE_DISCRIMINANT, 1_073_742_190);
    }
}
