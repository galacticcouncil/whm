//! `intent-router` end to end on a NEAR sandbox, against the **deployed mainnet code** of
//! `intents.near` (v0.4.5, `16d04f6`) and the Wormhole core, with a mock `v1.signer` that derives
//! and signs for real. Every payload the router signs is executed by the real verifier: signature,
//! NEP-413 digest, versioned nonce, salt, deadline and balances all checked by `intents.near`
//! itself.
//!
//! `wrap.near` stands in for both tokens — `eth` and `zec` below — since the router only knows
//! ledger ids and `intents.near` treats every NEP-141 alike.

use ed25519_dalek::{Signer, SigningKey};
use intent_router::order::Order;
use intent_router::quote::stable_json;
use intent_router::terms::{RecipientKind, Terms};
use intent_router::time;
use k256::ecdsa::SigningKey as GuardianKey;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Map, Value};
use sha3::{Digest, Keccak256};

const CORE_WASM: &[u8] = include_bytes!("wasm/contract.wormhole_crypto.near.wasm");
const WRAP_WASM: &[u8] = include_bytes!("wasm/wrap.near.wasm");
/// `view_code` of `intents.near`, code hash `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk`
/// (block 221,555,639) — v0.4.5 per its `contract_source_metadata`.
const INTENTS_WASM: &[u8] = include_bytes!("wasm/intents.near.wasm");

const HYDRATION: u16 = 73;
const EMITTER: [u8; 32] = [0xe1; 32];
const MAX_GAS: Gas = Gas::from_tgas(300);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const REGISTRATION: u128 = 1_250_000_000_000_000_000_000;

/// The order: 1 eth sent, priced at 2 zec per eth; the terms allow 1% below.
const ORDER_AMOUNT: u128 = 10u128.pow(24);
const RATE: u128 = 2 * 10u128.pow(18);

fn keccak(bytes: &[u8]) -> [u8; 32] {
    Keccak256::digest(bytes).into()
}

/// One test guardian, guardian set 0.
struct Guardian(GuardianKey);

impl Guardian {
    fn new(seed: u8) -> Self {
        Self(GuardianKey::from_bytes(&[seed; 32].into()).unwrap())
    }

    fn address(&self) -> String {
        let point = self.0.verifying_key().to_encoded_point(false);
        hex::encode(&keccak(&point.as_bytes()[1..])[12..])
    }

    /// A v1 VAA at `timestamp` (seconds), consistency 202.
    fn sign(&self, timestamp: u32, emitter_chain: u16, emitter: [u8; 32], sequence: u64, payload: &[u8]) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(&timestamp.to_be_bytes());
        body.extend_from_slice(&0u32.to_be_bytes());
        body.extend_from_slice(&emitter_chain.to_be_bytes());
        body.extend_from_slice(&emitter);
        body.extend_from_slice(&sequence.to_be_bytes());
        body.push(202);
        body.extend_from_slice(payload);
        let digest = keccak(&keccak(&body));
        let (sig, recovery) = self.0.sign_prehash_recoverable(&digest).unwrap();
        let mut vaa = vec![1, 0, 0, 0, 0, 1, 0];
        vaa.extend_from_slice(&sig.to_bytes());
        vaa.push(recovery.to_byte());
        vaa.extend_from_slice(&body);
        vaa
    }
}

struct Env {
    worker: Worker<Sandbox>,
    intents: Contract,
    eth: Contract,
    zec: Contract,
    router: Contract,
    alice: Account,
    bot: Account,
    guardian: Guardian,
    /// The test stand-in for 1Click's manager key.
    oneclick: SigningKey,
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

async fn wasm(var: &str, project: &str) -> anyhow::Result<Vec<u8>> {
    match std::env::var(var) {
        Ok(path) => Ok(std::fs::read(path)?),
        Err(_) => Ok(near_workspaces::compile_project(project).await?),
    }
}

fn ledger(token: &Contract) -> String {
    format!("nep141:{}", token.id())
}

async fn setup() -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let guardian = Guardian::new(0x11);

    let core = subaccount(&worker, "wormhole", 50).await?.deploy(CORE_WASM).await?.into_result()?;
    core.call("boot_wormhole")
        .args_json(json!({ "gset": 0, "addresses": [guardian.address()] }))
        .transact()
        .await?
        .into_result()?;

    let mpc = subaccount(&worker, "signer", 20)
        .await?
        .deploy(&wasm("MPC_WASM", "./mock-mpc").await?)
        .await?
        .into_result()?;
    mpc.call("new").transact().await?.into_result()?;

    let mut tokens = Vec::new();
    for name in ["eth", "zec"] {
        let token = subaccount(&worker, name, 50).await?.deploy(WRAP_WASM).await?.into_result()?;
        token.call("new").transact().await?.into_result()?;
        tokens.push(token);
    }
    let (eth, zec) = (tokens.remove(0), tokens.remove(0));

    let intents = subaccount(&worker, "intents", 100).await?.deploy(INTENTS_WASM).await?.into_result()?;
    intents
        .call("new")
        .args_json(json!({ "config": { "wnear_id": eth.id(), "fees": { "fee": 0, "fee_collector": intents.id() } } }))
        .transact()
        .await?
        .into_result()?;
    for token in [&eth, &zec] {
        // intents.near holds the tokens; a withdrawal through the bridge sends them to the token
        // contract itself, as POA's tokens take them.
        for holder in [intents.id(), token.id()] {
            intents
                .as_account()
                .call(token.id(), "storage_deposit")
                .args_json(json!({ "account_id": holder }))
                .deposit(NearToken::from_yoctonear(REGISTRATION))
                .transact()
                .await?
                .into_result()?;
        }
    }

    let oneclick = SigningKey::from_bytes(&[0x1c; 32]);
    let router = subaccount(&worker, "router", 50)
        .await?
        .deploy(&wasm("ROUTER_WASM", "../contracts/intent-router").await?)
        .await?
        .into_result()?;
    router
        .call("new")
        .args_json(json!({
            "owner": router.id(),
            "mpc_signer": mpc.id(),
            "intents": intents.id(),
            "core": core.id(),
            "emitter_chain": HYDRATION,
            "emitter": hex::encode(EMITTER),
            "eth_token": ledger(&eth),
            "quote_keys": [format!("ed25519:{}", bs58::encode(oneclick.verifying_key().to_bytes()).into_string())],
            "params": {
                "price_validity": 900,
                "max_quote_age": 120,
                "transfer_validity": 180,
                "max_fill_multiple": 2,
                "max_order_shortfall_bps": 2000,
                "min_refund": "1000",
            },
        }))
        .transact()
        .await?
        .into_result()?;

    let alice = subaccount(&worker, "alice", 100).await?;
    for token in [&eth, &zec] {
        alice.call(token.id(), "near_deposit").deposit(NearToken::from_near(20)).transact().await?.into_result()?;
    }
    let bot = subaccount(&worker, "bot", 50).await?;
    Ok(Env { worker, intents, eth, zec, router, alice, bot, guardian, oneclick })
}

impl Env {
    async fn now_ms(&self) -> anyhow::Result<u64> {
        Ok(self.worker.view_block().await?.timestamp() / 1_000_000)
    }

    fn terms(&self, deadline: u64, kind: RecipientKind, recipient: &str) -> Vec<u8> {
        Terms {
            owner: [0x33; 20],
            quote_id: [0x5a; 32],
            max_slippage_bps: 100,
            min_out_per_in: 0,
            // The batch threshold the deliver tests run against.
            min_delivery: 1_000_000,
            deadline,
            recipient_kind: kind,
            refund_to: [0x22; 20],
            destination_asset: ledger(&self.zec),
            recipient: recipient.into(),
        }
        .encode()
        .unwrap()
    }

    /// `A` for these terms, as the bot derives it.
    async fn account_of(&self, terms: &[u8]) -> anyhow::Result<String> {
        let path: String = self.router.view("path_of").args_json(json!({ "terms": b64(terms) })).await?.json()?;
        let config: Value = self.router.view("get_config").await?.json()?;
        let key: String = self
            .worker
            .view(&config["mpc_signer"].as_str().unwrap().parse()?, "derived_public_key")
            .args_json(json!({ "path": path, "predecessor": self.router.id(), "domain_id": 1 }))
            .await?
            .json()?;
        Ok(hex::encode(bs58::decode(key.trim_start_matches("ed25519:")).into_vec()?))
    }

    /// Alice deposits `amount` of `token` into `intents.near`, credited to `account`.
    async fn fund(&self, token: &Contract, account: &str, amount: u128) -> anyhow::Result<()> {
        self.alice
            .call(token.id(), "ft_transfer_call")
            .args_json(json!({ "receiver_id": self.intents.id(), "amount": amount.to_string(), "msg": account }))
            .deposit(ONE_YOCTO)
            .gas(MAX_GAS)
            .transact()
            .await?
            .into_result()?;
        Ok(())
    }

    async fn held(&self, account: &str, token: &Contract) -> anyhow::Result<u128> {
        let v: String = self
            .intents
            .view("mt_balance_of")
            .args_json(json!({ "account_id": account, "token_id": ledger(token) }))
            .await?
            .json()?;
        Ok(v.parse()?)
    }

    /// An order for `terms`, published now.
    async fn order(&self, terms: &[u8], seq: u64) -> anyhow::Result<Vec<u8>> {
        let order = Order { auth_path: keccak(terms), seq, amount: ORDER_AMOUNT, out_per_in: RATE };
        let now = (self.now_ms().await? / 1_000) as u32;
        Ok(self.guardian.sign(now, HYDRATION, EMITTER, seq, &order.encode()))
    }

    /// A quote shaped like 1Click's: an exact-input swap paying and refunding `account`, its deposit
    /// account `deposit`, signed by the test key over the same stable JSON.
    async fn quote(&self, account: &str, deposit: &str, amount_in: u128, min_out: u128) -> anyhow::Result<Value> {
        let now = self.now_ms().await?;
        let mut signed = Map::new();
        for (k, v) in [
            ("dry", json!(false)),
            ("swapType", json!("EXACT_INPUT")),
            ("slippageTolerance", json!(100)),
            ("originAsset", json!(ledger(&self.eth))),
            ("depositType", json!("INTENTS")),
            ("destinationAsset", json!(ledger(&self.zec))),
            ("amount", json!(amount_in.to_string())),
            ("refundTo", json!(account)),
            ("refundType", json!("INTENTS")),
            ("recipient", json!(account)),
            ("recipientType", json!("INTENTS")),
            ("amountIn", json!(amount_in.to_string())),
            ("amountOut", json!((min_out + min_out / 99).to_string())),
            ("minAmountOut", json!(min_out.to_string())),
            ("depositAddress", json!(deposit)),
            ("deadline", json!(time::format(now + 3 * 86_400_000))),
            ("timestamp", json!(time::format(now))),
        ] {
            signed.insert(k.into(), v);
        }
        let digest = sha2::Sha256::digest(stable_json(&signed).unwrap().as_bytes());
        let message = bs58::encode(digest).into_string();
        let signature = self.oneclick.sign(message.as_bytes());
        Ok(json!({ "signed": signed, "signature": format!("ed25519:{}", bs58::encode(signature.to_bytes()).into_string()) }))
    }

    async fn call_router(&self, method: &str, args: Value) -> anyhow::Result<ExecutionFinalResult> {
        Ok(self.bot.call(self.router.id(), method).args_json(args).deposit(ONE_YOCTO).gas(MAX_GAS).transact().await?)
    }

    /// What the bot submits: `execute_intents` on the verifier.
    async fn execute(&self, signed: &Value) -> anyhow::Result<ExecutionFinalResult> {
        Ok(self
            .bot
            .call(self.intents.id(), "execute_intents")
            .args_json(json!({ "signed": [signed] }))
            .gas(MAX_GAS)
            .transact()
            .await?)
    }
}

fn b64(bytes: &[u8]) -> String {
    use near_sdk::base64::Engine;
    near_sdk::base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The `intent_signed` event's data, or the failures that stopped it.
fn signed_event(outcome: &ExecutionFinalResult) -> anyhow::Result<Value> {
    for log in outcome.logs() {
        if let Some(json) = log.strip_prefix("EVENT_JSON:") {
            let e: Value = serde_json::from_str(json)?;
            if e["standard"] == "whm-intent-router" && e["event"] == "intent_signed" {
                return Ok(e["data"][0].clone());
            }
        }
    }
    anyhow::bail!("no intent_signed: {:?}", failures(outcome))
}

fn failures(outcome: &ExecutionFinalResult) -> Vec<String> {
    outcome.receipt_failures().into_iter().map(|f| format!("{f:?}")).collect()
}

/// Gas per receipt — what the static gas constants are sized from.
fn gas_report(label: &str, outcome: &ExecutionFinalResult) {
    let total: u64 = outcome.outcomes().iter().map(|o| o.gas_burnt.as_gas()).sum();
    println!("{label}: {:.1} TGas", total as f64 / 1e12);
    for o in outcome.outcomes() {
        println!("  {:>6.2} TGas  {}", o.gas_burnt.as_gas() as f64 / 1e12, o.executor_id);
    }
}

#[tokio::test]
async fn swap_executes_once_per_order() -> anyhow::Result<()> {
    let env = setup().await?;
    let now_s = env.now_ms().await? / 1_000;
    let terms = env.terms(now_s + 86_400, RecipientKind::Withdraw, "t1KPVSRgnFHPBWMJLC7taJioN6m5Q6jVBma");
    let a = env.account_of(&terms).await?;
    env.fund(&env.eth, &a, 3 * ORDER_AMOUNT).await?;

    // A holds 3 eth, the cap is 2 × the order's 1: the fill is 2. 2 zec per eth less 1% = 1.98 per
    // eth; the quote guarantees 1.99.
    let vaa = env.order(&terms, 7).await?;
    let quote = env.quote(&a, "oneclick-1.near", 2 * ORDER_AMOUNT, 199 * 2 * ORDER_AMOUNT / 100).await?;
    let outcome = env
        .call_router("swap", json!({ "terms": b64(&terms), "order_vaa": b64(&vaa), "quote": quote }))
        .await?;
    gas_report("swap", &outcome);
    let event = signed_event(&outcome)?;
    assert_eq!(event["action"], "swap");
    assert_eq!(event["account"], a);
    assert_eq!(event["seq"], 7);

    let executed = env.execute(&event["signed_data"]).await?;
    assert!(executed.is_success(), "{:?}", failures(&executed));
    assert_eq!(env.held(&a, &env.eth).await?, ORDER_AMOUNT);
    assert_eq!(env.held("oneclick-1.near", &env.eth).await?, 2 * ORDER_AMOUNT);

    // A second quote for the same order — the 1 eth left — signs the same nonce: the verifier
    // refuses it.
    let again = env.quote(&a, "oneclick-2.near", ORDER_AMOUNT, 199 * ORDER_AMOUNT / 100).await?;
    let outcome = env
        .call_router("swap", json!({ "terms": b64(&terms), "order_vaa": b64(&vaa), "quote": again }))
        .await?;
    let second = signed_event(&outcome)?;
    assert_ne!(second["receiver"], event["receiver"]);
    let replay = env.execute(&second["signed_data"]).await?;
    assert!(replay.is_failure(), "a second fill of one order executed");
    assert_eq!(env.held(&a, &env.eth).await?, ORDER_AMOUNT);

    // The next order fills again — the catch-up.
    let next = env.order(&terms, 8).await?;
    let quote = env.quote(&a, "oneclick-3.near", ORDER_AMOUNT, 199 * ORDER_AMOUNT / 100).await?;
    let outcome = env
        .call_router("swap", json!({ "terms": b64(&terms), "order_vaa": b64(&next), "quote": quote }))
        .await?;
    let executed = env.execute(&signed_event(&outcome)?["signed_data"]).await?;
    assert!(executed.is_success(), "{:?}", failures(&executed));
    assert_eq!(env.held(&a, &env.eth).await?, 0);
    Ok(())
}

#[tokio::test]
async fn swap_refuses_what_the_router_must_not_sign() -> anyhow::Result<()> {
    let env = setup().await?;
    let now_s = env.now_ms().await? / 1_000;
    let terms = env.terms(now_s + 86_400, RecipientKind::Withdraw, "t1KPVSRgnFHPBWMJLC7taJioN6m5Q6jVBma");
    let a = env.account_of(&terms).await?;
    let vaa = env.order(&terms, 7).await?;

    let refused = |outcome: ExecutionFinalResult, why: &'static str| {
        let all = failures(&outcome).join(" ");
        assert!(signed_event(&outcome).is_err(), "{why}: signed anyway");
        assert!(all.contains(why), "expected {why}, got {all}");
    };

    // The 2026-10-26 audit's order squat: a stranger credits A with dust before POA credits the
    // order's ETH, and asks for a swap of that dust. The order's own ETH has not arrived: refused,
    // and the order's nonce stays free.
    env.fund(&env.eth, &a, 1_000).await?;
    let quote = env.quote(&a, "oneclick-1.near", 1_000, 2_000).await?;
    let outcome = env.call_router("swap", json!({ "terms": b64(&terms), "order_vaa": b64(&vaa), "quote": quote })).await?;
    refused(outcome, "OrderNotCredited");

    // The order's ETH arrives: A holds 1 eth + the dust. The fill is all of it.
    env.fund(&env.eth, &a, ORDER_AMOUNT).await?;
    let fill = ORDER_AMOUNT + 1_000;

    // Less than A's whole balance.
    let quote = env.quote(&a, "oneclick-1.near", ORDER_AMOUNT / 2, ORDER_AMOUNT).await?;
    let outcome = env.call_router("swap", json!({ "terms": b64(&terms), "order_vaa": b64(&vaa), "quote": quote })).await?;
    refused(outcome, "WrongFillAmount");

    // Paying anyone but A.
    let quote = env.quote("attacker.near", "oneclick-1.near", fill, 2 * fill).await?;
    let outcome = env.call_router("swap", json!({ "terms": b64(&terms), "order_vaa": b64(&vaa), "quote": quote })).await?;
    refused(outcome, "WrongRecipient");

    // Below the order's floor (1.98 per eth).
    let quote = env.quote(&a, "oneclick-1.near", fill, 197 * fill / 100).await?;
    let outcome = env.call_router("swap", json!({ "terms": b64(&terms), "order_vaa": b64(&vaa), "quote": quote })).await?;
    refused(outcome, "BelowFloor");

    // An order no guardian signed: the real core refuses it.
    let forged = Guardian::new(0x99).sign((now_s) as u32, HYDRATION, EMITTER, 7, &vaa[vaa.len() - 73..]);
    let quote = env.quote(&a, "oneclick-1.near", fill, 2 * fill).await?;
    let outcome = env.call_router("swap", json!({ "terms": b64(&terms), "order_vaa": b64(&forged), "quote": quote })).await?;
    refused(outcome, "VaaVerifyFailed");

    // None of that spent the order: the bot's full fill still goes through.
    let quote = env.quote(&a, "oneclick-1.near", fill, 2 * fill).await?;
    let outcome = env.call_router("swap", json!({ "terms": b64(&terms), "order_vaa": b64(&vaa), "quote": quote })).await?;
    let executed = env.execute(&signed_event(&outcome)?["signed_data"]).await?;
    assert!(executed.is_success(), "{:?}", failures(&executed));
    assert_eq!(env.held(&a, &env.eth).await?, 0);
    Ok(())
}

#[tokio::test]
async fn deliver_withdraws_through_the_bridge() -> anyhow::Result<()> {
    let env = setup().await?;
    let now_s = env.now_ms().await? / 1_000;
    let terms = env.terms(now_s + 86_400, RecipientKind::Withdraw, "t1KPVSRgnFHPBWMJLC7taJioN6m5Q6jVBma");
    let a = env.account_of(&terms).await?;

    // Below the batch threshold before the deadline: nothing signed.
    env.fund(&env.zec, &a, 999_999).await?;
    let outcome = env.call_router("deliver", json!({ "terms": b64(&terms) })).await?;
    assert!(failures(&outcome).join(" ").contains("NothingToDeliver"), "{:?}", failures(&outcome));

    env.fund(&env.zec, &a, 1).await?;
    let outcome = env.call_router("deliver", json!({ "terms": b64(&terms) })).await?;
    gas_report("deliver", &outcome);
    let event = signed_event(&outcome)?;
    let bridge_before: String = env.zec.view("ft_balance_of").args_json(json!({ "account_id": env.zec.id() })).await?.json()?;
    let executed = env.execute(&event["signed_data"]).await?;
    assert!(executed.is_success(), "{:?}", failures(&executed));
    assert!(executed.logs().iter().any(|l| l.contains("WITHDRAW_TO:t1KPVSRgnFHPBWMJLC7taJioN6m5Q6jVBma")));
    assert_eq!(env.held(&a, &env.zec).await?, 0);
    let bridge_after: String = env.zec.view("ft_balance_of").args_json(json!({ "account_id": env.zec.id() })).await?.json()?;
    assert_eq!(bridge_after.parse::<u128>()? - bridge_before.parse::<u128>()?, 1_000_000);
    Ok(())
}

#[tokio::test]
async fn deliver_to_an_intents_account() -> anyhow::Result<()> {
    let env = setup().await?;
    let now_s = env.now_ms().await? / 1_000;
    let terms = env.terms(now_s + 86_400, RecipientKind::Intents, env.alice.id().as_str());
    let a = env.account_of(&terms).await?;
    env.fund(&env.zec, &a, 2_000_000).await?;

    let outcome = env.call_router("deliver", json!({ "terms": b64(&terms) })).await?;
    let executed = env.execute(&signed_event(&outcome)?["signed_data"]).await?;
    assert!(executed.is_success(), "{:?}", failures(&executed));
    assert_eq!(env.held(env.alice.id().as_str(), &env.zec).await?, 2_000_000);
    Ok(())
}

#[tokio::test]
async fn refund_only_after_the_deadline() -> anyhow::Result<()> {
    let env = setup().await?;
    let now_s = env.now_ms().await? / 1_000;

    // Before the deadline the call fails fast.
    let open = env.terms(now_s + 86_400, RecipientKind::Withdraw, "t1KPVSRgnFHPBWMJLC7taJioN6m5Q6jVBma");
    let outcome = env.call_router("refund", json!({ "terms": b64(&open) })).await?;
    assert!(outcome.is_failure());

    // Terms whose deadline has passed.
    let past = env.terms(now_s - 1, RecipientKind::Withdraw, "t1KPVSRgnFHPBWMJLC7taJioN6m5Q6jVBma");
    let a = env.account_of(&past).await?;
    env.fund(&env.eth, &a, ORDER_AMOUNT).await?;
    let outcome = env.call_router("refund", json!({ "terms": b64(&past) })).await?;
    gas_report("refund", &outcome);
    let event = signed_event(&outcome)?;
    assert_eq!(event["receiver"], "0x2222222222222222222222222222222222222222");

    let executed = env.execute(&event["signed_data"]).await?;
    assert!(executed.is_success(), "{:?}", failures(&executed));
    assert!(executed.logs().iter().any(|l| l.contains("WITHDRAW_TO:0x2222222222222222222222222222222222222222")));
    assert_eq!(env.held(&a, &env.eth).await?, 0);
    Ok(())
}

#[tokio::test]
async fn only_the_owner_configures() -> anyhow::Result<()> {
    let env = setup().await?;
    let outcome = env
        .bot
        .call(env.router.id(), "set_quote_keys")
        .args_json(json!({ "keys": [format!("ed25519:{}", bs58::encode([7u8; 32]).into_string())] }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?;
    assert!(failures(&outcome).join(" ").contains("Unauthorized"), "{:?}", failures(&outcome));
    Ok(())
}
