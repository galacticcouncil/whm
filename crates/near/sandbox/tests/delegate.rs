//! `utxo-withdraw` encodes NEP-366 delegate actions by hand. Here they are checked against
//! nearcore's own types: the same borsh bytes, the same signing hash, and a signature over that hash
//! that nearcore's `SignedDelegateAction::verify` accepts. No sandbox node needed.

use near_crypto::{KeyType, SecretKey, Signature};
use near_primitives::action::delegate::{DelegateAction, NonDelegateAction, SignedDelegateAction};
use near_primitives::action::{Action, FunctionCallAction};
use near_primitives::types::{AccountId, Gas, Balance};
use utxo_withdraw::delegate::{signed, signing_hash, Delegate};

fn keypair() -> (SecretKey, [u8; 32]) {
    let secret = SecretKey::from_seed(KeyType::ED25519, "utxo-withdraw");
    let key: [u8; 32] = secret.public_key().key_data().try_into().unwrap();
    (secret, key)
}

fn ours(key: [u8; 32], method: &'static str, receiver: &str, args: &[u8]) -> Delegate {
    Delegate {
        sender_id: hex::encode(key).parse().unwrap(),
        receiver_id: receiver.parse().unwrap(),
        method_name: method,
        args: args.to_vec(),
        gas: near_sdk::Gas::from_tgas(250),
        deposit: near_sdk::NearToken::from_yoctonear(1),
        nonce: 220_209_652_000_000,
        max_block_height: 220_210_252,
        public_key: key,
    }
}

fn theirs(secret: &SecretKey, method: &str, receiver: &str, args: &[u8]) -> DelegateAction {
    let public_key = secret.public_key();
    let call = Action::FunctionCall(Box::new(FunctionCallAction {
        method_name: method.into(),
        args: args.to_vec(),
        gas: Gas::from_teragas(250),
        deposit: Balance::from_yoctonear(1),
    }));
    DelegateAction {
        sender_id: hex::encode(public_key.key_data()).parse::<AccountId>().unwrap(),
        receiver_id: receiver.parse().unwrap(),
        actions: vec![NonDelegateAction::try_from(call).unwrap()],
        nonce: 220_209_652_000_000,
        max_block_height: 220_210_252,
        public_key,
    }
}

fn check(method: &'static str, receiver: &str, args: &[u8]) {
    let (secret, key) = keypair();
    let ours = ours(key, method, receiver, args);
    let theirs = theirs(&secret, method, receiver, args);

    let bytes = ours.encode();
    assert_eq!(bytes, borsh::to_vec(&theirs).unwrap(), "DelegateAction borsh");

    let hash = signing_hash(&bytes);
    assert_eq!(hash, theirs.get_nep461_hash().0, "NEP-461 signing hash");

    let Signature::ED25519(signature) = secret.sign(&hash) else { unreachable!() };
    let relayable: SignedDelegateAction = borsh::from_slice(&signed(&bytes, &signature.to_bytes())).unwrap();
    assert_eq!(relayable.delegate_action, theirs);
    assert!(relayable.verify(), "nearcore accepts the signature");
}

#[test]
fn withdraw_delegate_matches_nearcore() {
    let msg = r#"{"Withdraw":{"target_btc_address":"t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua","input":["959b9355b4157e21c927f3b1850b969ad80828125aa676b418031a25f641c099:0"],"output":[{"value":49980000,"script_pubkey":"76a91413bbd8bc8df03a5a9cda88103f583aa8bc043e2488ac"}],"max_gas_fee":"10000"}}"#;
    let args = near_sdk::serde_json::json!({
        "receiver_id": "zcash-connector.bridge.near",
        "amount": "50000000",
        "msg": msg,
    })
    .to_string();
    check("ft_transfer_call", "zec.omft.near", args.as_bytes());
}

#[test]
fn claim_delegate_matches_nearcore() {
    check("claim_lost_found", "zcash-connector.bridge.near", b"{}");
}
