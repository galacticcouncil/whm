//! End-to-end on a NEAR sandbox, against the **deployed mainnet code** of the Wormhole core and
//! `wrap.near` (`tests/wasm/`, fetched with `view_code`). Real promise chains, real `verify_vaa`
//! against a test guardian set, real NEP-141 storage and transfers.

use k256::ecdsa::SigningKey;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use ntt_manager::messages::{sequence_id, NativeTokenTransfer, NttManagerMessage, TransceiverMessage};
use ntt_manager::trimmed::TrimmedAmount;
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};

const CORE_WASM: &[u8] = include_bytes!("wasm/contract.wormhole_crypto.near.wasm");
const WRAP_WASM: &[u8] = include_bytes!("wasm/wrap.near.wasm");

const HYDRATION: u16 = 73;
const MANAGER: &str = "000000000000000000000000FCaF4aA069C565d25539028970703F01e47D3E0B";
const TRANSCEIVER: &str = "0000000000000000000000004e7b1e55d2354d4dc6abd876096dc201de0541d1";
const HYDRATION_RECIPIENT: &str = "0x1111111111111111111111111111111111111111";

const REGISTRATION: u128 = 1_250_000_000_000_000_000_000;
const MAX_GAS: Gas = Gas::from_tgas(300);

fn keccak(bytes: &[u8]) -> [u8; 32] {
    Keccak256::digest(bytes).into()
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    sha2::Sha256::digest(bytes).into()
}

fn bytes32(hex_str: &str) -> [u8; 32] {
    hex::decode(hex_str).unwrap().try_into().unwrap()
}

struct Guardian(SigningKey);

impl Guardian {
    fn new(seed: u8) -> Self {
        Self(SigningKey::from_bytes(&[seed; 32].into()).unwrap())
    }

    fn address(&self) -> String {
        let point = self.0.verifying_key().to_encoded_point(false);
        hex::encode(&keccak(&point.as_bytes()[1..])[12..])
    }

    /// A v1 VAA from guardian set 0, signed by this guardian alone.
    fn sign(&self, emitter_chain: u16, emitter: [u8; 32], sequence: u64, payload: &[u8]) -> String {
        let mut body = Vec::new();
        body.extend_from_slice(&0u32.to_be_bytes()); // timestamp
        body.extend_from_slice(&0u32.to_be_bytes()); // nonce
        body.extend_from_slice(&emitter_chain.to_be_bytes());
        body.extend_from_slice(&emitter);
        body.extend_from_slice(&sequence.to_be_bytes());
        body.push(200);
        body.extend_from_slice(payload);

        let digest = keccak(&keccak(&body));
        let (sig, recovery) = self.0.sign_prehash_recoverable(&digest).unwrap();

        let mut vaa = vec![1, 0, 0, 0, 0, 1, 0];
        vaa.extend_from_slice(&sig.to_bytes());
        vaa.push(recovery.to_byte());
        vaa.extend_from_slice(&body);
        hex::encode(vaa)
    }
}

/// What Hydration's manager would send `amount` (8 dp) of to `account` on NEAR.
fn hydration_transfer(ntt: &Contract, account: &str, amount: u64, id: u64) -> Vec<u8> {
    let ntt_msg = NativeTokenTransfer {
        amount: TrimmedAmount { amount, decimals: 8 },
        source_token: [7; 32],
        to: sha256(account.as_bytes()),
        to_chain: 15,
        additional_payload: Vec::new(),
    };
    let manager = NttManagerMessage { id: sequence_id(id), sender: [9; 32], payload: ntt_msg.encode().unwrap() };
    TransceiverMessage {
        source_manager: bytes32(MANAGER),
        recipient_manager: sha256(ntt.id().as_bytes()),
        manager_payload: manager.encode().unwrap(),
        transceiver_payload: Vec::new(),
    }
    .encode()
    .unwrap()
}

struct Env {
    worker: Worker<Sandbox>,
    core: Contract,
    token: Contract,
    ntt: Contract,
    alice: Account,
    relayer: Account,
    guardian: Guardian,
}

async fn subaccount(worker: &Worker<Sandbox>, name: &str, near: u128) -> anyhow::Result<Account> {
    Ok(worker
        .root_account()?
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(near))
        .transact()
        .await?
        .into_result()?)
}

async fn setup(register_emitter: bool) -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let guardian = Guardian::new(0x11);

    let core = subaccount(&worker, "wormhole", 50).await?.deploy(CORE_WASM).await?.into_result()?;
    // `Default` takes the first signer's key as owner; booting is that first call.
    core.call("boot_wormhole")
        .args_json(json!({ "gset": 0, "addresses": [guardian.address()] }))
        .transact()
        .await?
        .into_result()?;

    let token = subaccount(&worker, "wrap", 50).await?.deploy(WRAP_WASM).await?.into_result()?;
    token.call("new").transact().await?.into_result()?;

    let wasm = ntt_wasm().await?;
    let ntt = subaccount(&worker, "ntt", 50).await?.deploy(&wasm).await?.into_result()?;
    ntt.call("new")
        .args_json(json!({
            "owner": ntt.id(),
            "token": token.id(),
            "token_decimals": 24,
            "registration_deposit": REGISTRATION.to_string(),
            "core": core.id(),
            "outbound_limit": (1_000u128 * 10u128.pow(24)).to_string(),
        }))
        .transact()
        .await?
        .into_result()?;
    ntt.call("set_peer")
        .args_json(json!({
            "chain_id": HYDRATION,
            "manager": MANAGER,
            "transceiver": TRANSCEIVER,
            "decimals": 18,
            "inbound_limit": (1_000u128 * 10u128.pow(24)).to_string(),
        }))
        .transact()
        .await?
        .into_result()?;

    if register_emitter {
        ntt.as_account()
            .call(core.id(), "register_emitter")
            .args_json(json!({ "emitter": ntt.id() }))
            .deposit(NearToken::from_millinear(10))
            .transact()
            .await?
            .into_result()?;
    }
    storage_deposit(&token, ntt.as_account()).await?;

    let alice = subaccount(&worker, "alice", 50).await?;
    storage_deposit(&token, &alice).await?;
    alice
        .call(token.id(), "near_deposit")
        .deposit(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;

    let relayer = subaccount(&worker, "relayer", 50).await?;
    Ok(Env { worker, core, token, ntt, alice, relayer, guardian })
}

/// `NTT_WASM` if set — a prebuilt contract — else `cargo near build` through near-workspaces.
async fn ntt_wasm() -> anyhow::Result<Vec<u8>> {
    match std::env::var("NTT_WASM") {
        Ok(path) => Ok(std::fs::read(path)?),
        Err(_) => Ok(near_workspaces::compile_project("../contracts/ntt-manager").await?),
    }
}

async fn storage_deposit(token: &Contract, account: &Account) -> anyhow::Result<()> {
    account
        .call(token.id(), "storage_deposit")
        .args_json(json!({ "account_id": account.id(), "registration_only": true }))
        .deposit(NearToken::from_yoctonear(REGISTRATION))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn balance(token: &Contract, account: &str) -> anyhow::Result<u128> {
    let v: String = token.view("ft_balance_of").args_json(json!({ "account_id": account })).await?.json()?;
    Ok(v.parse()?)
}

async fn view<T: serde::de::DeserializeOwned>(ntt: &Contract, method: &str, args: Value) -> anyhow::Result<T> {
    Ok(ntt.view(method).args_json(args).await?.json()?)
}

/// Every `EVENT_JSON` log across the transaction's receipts.
fn events(result: &ExecutionFinalResult) -> Vec<Value> {
    result
        .logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn event<'a>(events: &'a [Value], standard: &str, name: &str) -> Option<&'a Value> {
    events.iter().find(|e| e["standard"] == standard && e["event"] == name)
}

fn gas(label: &str, result: &ExecutionFinalResult) {
    println!("gas {label}: {} TGas burnt", result.total_gas_burnt.as_tgas());
}

/// After refunds land: what the relayer lost beyond burnt gas, and what the contract gained.
/// "Kept-out" includes NEAR's gas-refund penalty on unused prepaid gas, so it is never exactly 0.
async fn settle(
    env: &Env,
    relayer_before: NearToken,
    ntt_before: NearToken,
    result: &ExecutionFinalResult,
) -> anyhow::Result<(NearToken, NearToken)> {
    // Gas and deposit refunds are receipts of their own; give them blocks to execute.
    env.worker.fast_forward(5).await?;
    let spent = relayer_before.saturating_sub(env.relayer.view_account().await?.balance);
    let gain = env.ntt.view_account().await?.balance.saturating_sub(ntt_before);
    Ok((spent.saturating_sub(burnt(result)), gain))
}

/// NEAR burnt on gas across every receipt of the transaction.
fn burnt(result: &ExecutionFinalResult) -> NearToken {
    result
        .outcomes()
        .iter()
        .fold(NearToken::from_yoctonear(0), |acc, o| acc.saturating_add(o.tokens_burnt))
}

async fn send_to_hydration(env: &Env, amount: u128) -> anyhow::Result<ExecutionFinalResult> {
    let msg = json!({ "recipient_chain": HYDRATION, "recipient": HYDRATION_RECIPIENT }).to_string();
    Ok(env
        .alice
        .call(env.token.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": env.ntt.id(), "amount": amount.to_string(), "msg": msg }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(MAX_GAS)
        .transact()
        .await?)
}

async fn complete(env: &Env, vaa: &str, account: &str) -> anyhow::Result<ExecutionFinalResult> {
    Ok(env
        .relayer
        .call(env.ntt.id(), "complete")
        .args_json(json!({ "vaa": vaa, "account_id": account }))
        .deposit(NearToken::from_millinear(10))
        .gas(MAX_GAS)
        .transact()
        .await?)
}

#[tokio::test]
async fn outbound_locks_and_publishes() -> anyhow::Result<()> {
    let env = setup(true).await?;
    // 1.5 NEAR + 1 yocto: the yocto is trim dust and must come back.
    let amount = 1_500_000_000_000_000_000_000_001u128;
    let before = balance(&env.token, env.alice.id().as_str()).await?;

    let result = send_to_hydration(&env, amount).await?;
    gas("outbound", &result);
    assert!(result.is_success(), "{:?}", result.failures());

    let locked = 1_500_000_000_000_000_000_000_000u128;
    assert_eq!(before - balance(&env.token, env.alice.id().as_str()).await?, locked);
    assert_eq!(balance(&env.token, env.ntt.id().as_str()).await?, locked);

    let events = events(&result);
    let publish = event(&events, "wormhole", "publish").expect("core publish event");
    assert_eq!(publish["emitter"], hex::encode(sha256(env.ntt.id().as_bytes())));
    let sent = event(&events, "whm-ntt", "transfer_sent").expect("transfer_sent");
    assert_eq!(sent["data"][0]["wormhole_sequence"], publish["seq"]);

    println!("published payload: {}", publish["data"].as_str().unwrap());
    let payload = hex::decode(publish["data"].as_str().unwrap())?;
    let tm = TransceiverMessage::parse(&payload).unwrap();
    assert_eq!(tm.source_manager, sha256(env.ntt.id().as_bytes()));
    assert_eq!(tm.recipient_manager, bytes32(MANAGER));
    let mm = NttManagerMessage::parse(&tm.manager_payload).unwrap();
    assert_eq!(mm.sender, sha256(env.alice.id().as_bytes()));
    let ntt = NativeTokenTransfer::parse(&mm.payload).unwrap();
    assert_eq!(ntt.amount, TrimmedAmount { amount: 150_000_000, decimals: 8 });
    assert_eq!(ntt.source_token, sha256(env.token.id().as_bytes()));
    assert_eq!(ntt.to_chain, HYDRATION);
    Ok(())
}

#[tokio::test]
async fn failed_publish_refunds_the_sender() -> anyhow::Result<()> {
    // Not registered as an emitter: the core's publish_message panics.
    let env = setup(false).await?;
    let before = balance(&env.token, env.alice.id().as_str()).await?;
    let capacity_before: String = view(&env.ntt, "outbound_capacity", json!({})).await?;

    let result = send_to_hydration(&env, 10u128.pow(24)).await?;
    gas("outbound, failed publish", &result);

    assert_eq!(balance(&env.token, env.alice.id().as_str()).await?, before);
    assert_eq!(balance(&env.token, env.ntt.id().as_str()).await?, 0);
    let capacity: String = view(&env.ntt, "outbound_capacity", json!({})).await?;
    assert_eq!(capacity, capacity_before);
    assert!(event(&events(&result), "whm-ntt", "transfer_failed").is_some());
    Ok(())
}

#[tokio::test]
async fn inbound_verifies_registers_and_pays() -> anyhow::Result<()> {
    let env = setup(true).await?;
    // Custody first: alice locks 5 NEAR.
    assert!(send_to_hydration(&env, 5 * 10u128.pow(24)).await?.is_success());

    let bob = format!("bob.{}", env.worker.root_account()?.id());
    let payload = hydration_transfer(&env.ntt, &bob, 150_000_000, 1);
    let vaa = env.guardian.sign(HYDRATION, bytes32(TRANSCEIVER), 1, &payload);

    let relayer_before = env.relayer.view_account().await?.balance;
    let ntt_before = env.ntt.view_account().await?.balance;
    let result = complete(&env, &vaa, &bob).await?;
    gas("inbound, registering", &result);
    assert!(result.is_success(), "{:?}", result.failures());

    // bob was never registered: complete paid for it, then the transfer.
    assert_eq!(balance(&env.token, &bob).await?, 1_500_000_000_000_000_000_000_000);
    assert!(event(&events(&result), "whm-ntt", "transfer_received").is_some());

    // Beyond gas, the relayer paid the registration and the replay entry — the rest of the 0.01
    // NEAR deposit came back.
    let (kept, ntt_gain) = settle(&env, relayer_before, ntt_before, &result).await?;
    println!(
        "complete: relayer kept-out {} yocto (registration {REGISTRATION}), contract gained {} yocto",
        kept.as_yoctonear(),
        ntt_gain.as_yoctonear()
    );
    assert!(kept.as_yoctonear() >= REGISTRATION);
    assert!(kept < NearToken::from_millinear(10).saturating_sub(NearToken::from_millinear(5)));
    // The contract keeps its storage and a share of gas rewards — never the registration.
    assert!(ntt_gain < NearToken::from_millinear(1));

    // Replay: refused before any cross-contract call, deposit returned.
    let replay = complete(&env, &vaa, &bob).await?;
    assert!(replay.is_failure());
    assert_eq!(balance(&env.token, &bob).await?, 1_500_000_000_000_000_000_000_000);
    Ok(())
}

#[tokio::test]
async fn forged_signature_consumes_nothing() -> anyhow::Result<()> {
    let env = setup(true).await?;
    assert!(send_to_hydration(&env, 5 * 10u128.pow(24)).await?.is_success());

    let bob = format!("bob.{}", env.worker.root_account()?.id());
    let payload = hydration_transfer(&env.ntt, &bob, 150_000_000, 1);
    let forged = Guardian::new(0x22).sign(HYDRATION, bytes32(TRANSCEIVER), 1, &payload);

    let relayer_before = env.relayer.view_account().await?.balance;
    let ntt_before = env.ntt.view_account().await?.balance;
    let result = complete(&env, &forged, &bob).await?;
    gas("inbound, forged", &result);

    assert_eq!(balance(&env.token, &bob).await?, 0);
    let bytes = hex::decode(&forged)?;
    let v = ntt_manager::vaa::Vaa::parse(&bytes).unwrap();
    let tm = TransceiverMessage::parse(&v.payload).unwrap();
    let digest = ntt_manager::messages::manager_message_digest(HYDRATION, &tm.manager_payload);
    let executed: bool = view(&env.ntt, "is_executed", json!({ "digest": hex::encode(digest) })).await?;
    assert!(!executed);

    // Deposit refunded by on_complete_settled: only gas, and the gas-refund penalty, are gone.
    let (kept, ntt_gain) = settle(&env, relayer_before, ntt_before, &result).await?;
    println!(
        "forged: relayer kept-out {} yocto, contract gained {} yocto",
        kept.as_yoctonear(),
        ntt_gain.as_yoctonear()
    );
    assert!(kept < NearToken::from_millinear(1));
    assert!(ntt_gain < NearToken::from_millinear(1));
    Ok(())
}

#[tokio::test]
async fn failed_unlock_is_claimable() -> anyhow::Result<()> {
    // No custody: the pay-out's ft_transfer fails for lack of balance.
    let env = setup(true).await?;
    let bob = env.worker.root_account()?.create_subaccount("bob").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;

    let payload = hydration_transfer(&env.ntt, bob.id().as_str(), 150_000_000, 1);
    let vaa = env.guardian.sign(HYDRATION, bytes32(TRANSCEIVER), 1, &payload);
    let result = complete(&env, &vaa, bob.id().as_str()).await?;
    assert!(result.is_success(), "{:?}", result.failures());
    assert!(event(&events(&result), "whm-ntt", "payout_failed").is_some());

    let claimable: String = view(&env.ntt, "claimable_of", json!({ "account_id": bob.id() })).await?;
    assert_eq!(claimable, "1500000000000000000000000");

    // Custody arrives; bob claims.
    assert!(send_to_hydration(&env, 5 * 10u128.pow(24)).await?.is_success());
    let claim = bob
        .call(env.ntt.id(), "claim")
        .deposit(NearToken::from_yoctonear(1))
        .gas(MAX_GAS)
        .transact()
        .await?;
    gas("claim", &claim);
    assert!(claim.is_success(), "{:?}", claim.failures());
    assert_eq!(balance(&env.token, bob.id().as_str()).await?, 1_500_000_000_000_000_000_000_000);
    let claimable: String = view(&env.ntt, "claimable_of", json!({ "account_id": bob.id() })).await?;
    assert_eq!(claimable, "0");
    let _ = &env.core;
    Ok(())
}

#[tokio::test]
async fn over_the_limit_reverts_and_refunds() -> anyhow::Result<()> {
    let env = setup(true).await?;
    env.ntt
        .call("set_outbound_limit")
        .args_json(json!({ "limit": 10u128.pow(24).to_string() }))
        .transact()
        .await?
        .into_result()?;
    let before = balance(&env.token, env.alice.id().as_str()).await?;

    let result = send_to_hydration(&env, 2 * 10u128.pow(24)).await?;
    gas("outbound, over the limit", &result);

    // ft_on_transfer panicked: the token's ft_resolve_transfer refunded everything.
    assert_eq!(balance(&env.token, env.alice.id().as_str()).await?, before);
    assert_eq!(balance(&env.token, env.ntt.id().as_str()).await?, 0);
    assert!(event(&events(&result), "wormhole", "publish").is_none());
    let capacity: String = view(&env.ntt, "outbound_capacity", json!({})).await?;
    assert_eq!(capacity, 10u128.pow(24).to_string());
    Ok(())
}
