//! Intent router — signs NEAR Intents payloads for accounts derived from a user's terms. Design:
//! `docs/intents-v2/spec.md`, wire formats `docs/intents-v2/schema.md`, the mainnet run it is built
//! on `docs/intents-v2/poc.md`.
//!
//! ```text
//! terms = one action's rules    path = keccak256(terms)    A = v1.signer key for (self, path)
//!
//! swap(terms, order_vaa, quote)
//!   ├─ v1.signer.derived_public_key(path)   ┐
//!   ├─ intents.current_salt()               │ joint
//!   └─ core.verify_vaa(order_vaa)           ┘
//!        → on_swap_reads: order, 1Click quote and floor checked
//!             → v1.signer.sign(a transfer of amountIn ETH from A to the quote's deposit account)
//!                  → on_signed: emit the MultiPayload
//! deliver(terms) | refund(terms)
//!   ├─ derived_public_key(path) ┐ joint
//!   └─ current_salt()           ┘
//!        → on_payout_key: intents.mt_balance_of(A, token)
//!             → on_payout_balance: A's whole balance to the terms' recipient | refundTo → sign → on_signed
//! ```
//!
//! Nothing is stored per account. Anyone may call; the bot publishes what is signed.
//!
//! **The invariant.** Every path to `sign` builds its payload only from the terms (bound to `A` by
//! the hash), a verified order message, a quote 1Click signed, the clock and balance reads — and
//! only one of three: a transfer to the deposit account of a quote that pays and refunds `A`, at or
//! above the order's floor; `A`'s destination asset to the terms' recipient; after the deadline,
//! `A`'s ETH to the terms' `refundTo`. No admin sign, no generic `sign(payload)`, no public callback.

pub mod floor;
pub mod intent;
pub mod order;
pub mod quote;
pub mod terms;

/// Shared with the other WHM contracts.
pub use near_common::{mpc, time, vaa};

use std::collections::BTreeMap;

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

use intent::{eip55, entropy, ft_withdraw, multi_payload, nep413_digest, transfer, versioned_nonce};
use mpc::{ext_mpc, implicit_account, parse_ed25519, Payload, SignRequest, SignatureResponse, DOMAIN_ED25519};
use order::Order;
use quote::{Expect, Quote};
use terms::{auth_path, path_string, RecipientKind, Terms};
use vaa::{ext_wormhole, Vaa};

pub const GAS_FOR_DERIVE: Gas = Gas::from_tgas(10);
pub const GAS_FOR_SALT: Gas = Gas::from_tgas(5);
/// What the token bridge on NEAR gives `verify_vaa`.
pub const GAS_FOR_VERIFY: Gas = Gas::from_tgas(30);
pub const GAS_FOR_BALANCE: Gas = Gas::from_tgas(5);
/// `v1.signer` requires 15 TGas attached; the rest covers its yield callback.
pub const GAS_FOR_SIGN: Gas = Gas::from_tgas(30);
pub const GAS_FOR_ON_SIGNED: Gas = Gas::from_tgas(10);
/// `on_swap_reads`' own work — the quote's JSON, hash and signature — then the sign it schedules.
pub const GAS_FOR_ON_SWAP_READS: Gas = Gas::from_tgas(20 + 30 + 10);
/// `on_payout_balance`'s own work, then the sign it schedules.
pub const GAS_FOR_ON_PAYOUT_BALANCE: Gas = Gas::from_tgas(15 + 30 + 10);
/// `on_payout_key`'s own work, the balance read and `on_payout_balance`.
pub const GAS_FOR_ON_PAYOUT_KEY: Gas = Gas::from_tgas(10 + 5 + 55);

/// `migrate` on the new code, in the same batch as its deploy.
pub const GAS_FOR_MIGRATE: Gas = Gas::from_tgas(50);

/// Upper bounds on the timing params, seconds.
pub const MAX_PRICE_VALIDITY: u64 = 86_400;
pub const MAX_QUOTE_AGE: u64 = 600;
pub const MAX_TRANSFER_VALIDITY: u64 = 600;
pub const MAX_FILL_MULTIPLE: u32 = 100;

/// The `v1.signer` deposit.
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// The NEP-141 prefix of an intents ledger id; the rest is the token contract.
const NEP141: &str = "nep141:";

/// The memo POA's bridge tokens read the destination address from.
const WITHDRAW_TO: &str = "WITHDRAW_TO:";

#[ext_contract(ext_intents)]
pub trait Verifier {
    /// 4 bytes, hex.
    fn current_salt(&self) -> String;
    fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128;
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Params {
    /// Seconds after the order's Hydration block its price may still be filled at.
    pub price_validity: u64,
    /// Seconds after 1Click signed a quote it may still be acted on.
    pub max_quote_age: u64,
    /// Seconds a signed transfer stays executable.
    pub transfer_validity: u64,
    /// One fill per order, of at most this many times the order's own amount — the catch-up rate,
    /// and what a bad quote can move at once.
    pub max_fill_multiple: u32,
    /// The smallest ETH refund, wei — above POA's withdrawal fee.
    pub min_refund: U128,
}

/// A destination asset the router swaps into and delivers.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Route {
    /// The bridge's smallest withdrawal — every delivery is at least this.
    pub min_withdraw: U128,
    /// Before the deadline, deliveries wait until `A` holds this much: one bridge fee per batch,
    /// not per tranche. At least `min_withdraw`.
    pub min_delivery: U128,
}

#[near(serializers = [json])]
pub enum Payout {
    Deliver,
    Refund,
}

/// What a signed payload does, for its event.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Signed {
    pub action: String,
    pub account: AccountId,
    pub auth_path: String,
    /// The order filled — swaps only.
    pub seq: Option<u64>,
    /// The ledger id that leaves `A`.
    pub token: String,
    pub amount: U128,
    /// The quote's guaranteed output — swaps only.
    pub min_amount_out: Option<U128>,
    /// The deposit account, the recipient, or `refundTo`.
    pub receiver: String,
}

/// A payload ready for `v1.signer`.
pub(crate) struct Plan {
    path: [u8; 32],
    key: [u8; 32],
    message: String,
    nonce: [u8; 32],
    info: Signed,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct IntentRouter {
    owner: AccountId,
    /// Proposed by `transfer_ownership`, owner once it calls `accept_ownership`.
    pending_owner: Option<AccountId>,

    /// `v1.signer` on mainnet.
    mpc_signer: AccountId,
    /// `intents.near` — the verifier, and the NEP-413 recipient.
    intents: AccountId,
    /// `contract.wormhole_crypto.near`.
    core: AccountId,
    /// Hydration's Wormhole chain id, 73, and `IntentQuoteEmitter`.
    emitter_chain: u16,
    emitter: [u8; 32],
    /// What `A` is credited and sells: `nep141:eth.omft.near`.
    eth_token: String,

    /// 1Click's quote-signing keys. A quote signed by any of them verifies, so a rotation announced
    /// in advance has no gap.
    quote_keys: Vec<[u8; 32]>,
    params: Params,
    /// Destination ledger id → route. A handful; read whole.
    routes: BTreeMap<String, Route>,
}

#[near]
impl IntentRouter {
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner: AccountId,
        mpc_signer: AccountId,
        intents: AccountId,
        core: AccountId,
        emitter_chain: u16,
        emitter: String,
        eth_token: String,
        quote_keys: Vec<String>,
        params: Params,
    ) -> Self {
        require!(emitter_chain != 0, "InvalidEmitterChain");
        let emitter = parse_hex32(&emitter);
        require!(emitter != [0; 32], "InvalidEmitter");
        token_contract(&eth_token);
        let this = Self {
            owner,
            pending_owner: None,
            mpc_signer,
            intents,
            core,
            emitter_chain,
            emitter,
            eth_token,
            quote_keys: parse_quote_keys(&quote_keys),
            params,
            routes: BTreeMap::new(),
        };
        this.assert_params();
        this
    }

    // =============== Signing ================================================================

    /// Signs `A`'s transfer of the quote's `amountIn` ETH to 1Click's deposit account — the swap.
    /// The order message prices it; the quote, signed by 1Click, must pay and refund `A` at or above
    /// that price. One fill per order. Anyone may call, with 1 yocto — the signer's deposit.
    #[payable]
    pub fn swap(&mut self, terms: Base64VecU8, order_vaa: Base64VecU8, quote: Quote) -> Promise {
        near_sdk::assert_one_yocto();
        self.require_gas(
            GAS_FOR_DERIVE.saturating_add(GAS_FOR_SALT).saturating_add(GAS_FOR_VERIFY).saturating_add(GAS_FOR_ON_SWAP_READS),
        );
        // Fail fast on everything checkable before the reads; on_swap_reads checks it all again.
        let (t, path) = self.swap_terms(&terms.0);
        self.order(&t, &path, &order_vaa.0, now_ms());
        quote::verify(&quote, &self.quote_keys).unwrap_or_else(|e| env::panic_str(e));

        self.reads(&path)
            .and(ext_wormhole::ext(self.core.clone()).with_static_gas(GAS_FOR_VERIFY).verify_vaa(hex::encode(&order_vaa.0)))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_SWAP_READS)
                    .on_swap_reads(terms, order_vaa, quote),
            )
    }

    /// Signs the transfer of `A`'s whole destination balance to the terms' recipient. Before the
    /// deadline only once it reaches the route's `min_delivery`; after it, from `min_withdraw`.
    #[payable]
    pub fn deliver(&mut self, terms: Base64VecU8) -> Promise {
        self.payout(terms, Payout::Deliver)
    }

    /// After the deadline, signs the withdrawal of `A`'s whole ETH balance to the terms' `refundTo`
    /// on Ethereum. Reads no route: a refund never depends on config the owner can change.
    #[payable]
    pub fn refund(&mut self, terms: Base64VecU8) -> Promise {
        self.payout(terms, Payout::Refund)
    }

    #[private]
    pub fn on_swap_reads(
        &mut self,
        terms: Base64VecU8,
        order_vaa: Base64VecU8,
        quote: Quote,
        #[callback_result] key: Result<String, PromiseError>,
        #[callback_result] salt: Result<String, PromiseError>,
        #[callback_result] verified: Result<u32, PromiseError>,
    ) -> Promise {
        let key = parse_ed25519(&key.unwrap_or_else(|_| env::panic_str("DeriveFailed")));
        let salt = parse_salt(&salt.unwrap_or_else(|_| env::panic_str("SaltReadFailed")));
        require!(verified.is_ok(), "VaaVerifyFailed");
        let plan = self.build_swap(&terms.0, &order_vaa.0, &quote, key, salt, now_ms());
        self.sign(plan)
    }

    #[private]
    pub fn on_payout_key(
        &mut self,
        terms: Base64VecU8,
        payout: Payout,
        #[callback_result] key: Result<String, PromiseError>,
        #[callback_result] salt: Result<String, PromiseError>,
    ) -> Promise {
        let key = parse_ed25519(&key.unwrap_or_else(|_| env::panic_str("DeriveFailed")));
        let salt = parse_salt(&salt.unwrap_or_else(|_| env::panic_str("SaltReadFailed")));
        let t = parse_terms(&terms.0);
        let token = match payout {
            Payout::Deliver => t.destination_asset,
            Payout::Refund => self.eth_token.clone(),
        };
        ext_intents::ext(self.intents.clone())
            .with_static_gas(GAS_FOR_BALANCE)
            .mt_balance_of(implicit_account(&key), token)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_PAYOUT_BALANCE)
                    .on_payout_balance(terms, payout, hex::encode(key), hex::encode(salt)),
            )
    }

    #[private]
    pub fn on_payout_balance(
        &mut self,
        terms: Base64VecU8,
        payout: Payout,
        key: String,
        salt: String,
        #[callback_result] balance: Result<U128, PromiseError>,
    ) -> Promise {
        let balance = balance.unwrap_or_else(|_| env::panic_str("BalanceReadFailed")).0;
        let plan = self.build_payout(&terms.0, payout, parse_hex32(&key), parse_salt(&salt), balance, now_ms(), env::block_height());
        self.sign(plan)
    }

    /// Checks the signature against `A`'s key and emits the publishable `MultiPayload`.
    #[private]
    pub fn on_signed(
        &mut self,
        message: String,
        nonce: String,
        key: String,
        info: Signed,
        #[callback_result] response: Result<SignatureResponse, PromiseError>,
    ) -> Value {
        let signature = response.unwrap_or_else(|_| env::panic_str("SignFailed")).ed25519();
        let nonce = parse_hex32(&nonce);
        let key = parse_hex32(&key);
        let digest = nep413_digest(&message, &nonce, self.intents.as_str());
        require!(env::ed25519_verify(&signature, digest, &key), "InvalidSignature");

        let signed = multi_payload(&message, &nonce, self.intents.as_str(), &key, &signature);
        emit("intent_signed", json!({
            "action": info.action,
            "account": info.account,
            "auth_path": info.auth_path,
            "seq": info.seq,
            "token": info.token,
            "amount": info.amount,
            "min_amount_out": info.min_amount_out,
            "receiver": info.receiver,
            "signed_data": signed,
        }));
        signed
    }

    // =============== Admin ==================================================================
    //
    // Every owner method takes exactly 1 yocto, so each needs a full-access key on the owner
    // account. Each logs an event.

    #[payable]
    pub fn set_params(&mut self, params: Params) {
        self.assert_owner();
        self.params = params;
        self.assert_params();
        emit("params_set", json!(self.params));
    }

    /// Replaces 1Click's key set. Add the new key before 1Click rotates, drop the old one after.
    #[payable]
    pub fn set_quote_keys(&mut self, keys: Vec<String>) {
        self.assert_owner();
        self.quote_keys = parse_quote_keys(&keys);
        emit("quote_keys_set", json!({ "keys": keys }));
    }

    /// Adds or replaces a destination. `asset` is a `nep141:` ledger id; its contract is what
    /// deliveries withdraw.
    #[payable]
    pub fn set_route(&mut self, asset: String, route: Route) {
        self.assert_owner();
        token_contract(&asset);
        require!(asset != self.eth_token, "SameAsset");
        require!(route.min_withdraw.0 > 0 && route.min_delivery.0 >= route.min_withdraw.0, "InvalidRoute");
        emit("route_set", json!({ "asset": asset, "route": route }));
        self.routes.insert(asset, route);
    }

    /// Stops swaps into `asset` and its deliveries. Refunds are unaffected.
    #[payable]
    pub fn remove_route(&mut self, asset: String) {
        self.assert_owner();
        require!(self.routes.remove(&asset).is_some(), "UnsupportedRoute");
        emit("route_removed", json!({ "asset": asset }));
    }

    /// Proposes `new_owner`, who takes over on `accept_ownership`. Proposing again replaces it.
    #[payable]
    pub fn transfer_ownership(&mut self, new_owner: AccountId) {
        self.assert_owner();
        emit("ownership_transfer_started", json!({ "owner": self.owner, "pending_owner": new_owner }));
        self.pending_owner = Some(new_owner);
    }

    /// Completes `transfer_ownership`, called by the proposed owner with 1 yocto.
    #[payable]
    pub fn accept_ownership(&mut self) {
        near_sdk::assert_one_yocto();
        let caller = env::predecessor_account_id();
        require!(self.pending_owner.as_ref() == Some(&caller), "Unauthorized");
        emit("ownership_transferred", json!({ "previous_owner": self.owner, "new_owner": caller }));
        self.owner = caller;
        self.pending_owner = None;
    }

    /// Redeploys this contract with the wasm passed as the call's raw input, then runs the new
    /// code's `migrate` — one batch, so a failing `migrate` reverts the deploy too.
    ///
    /// Derivation binds to this account id, not the code: whoever can upgrade controls every `A`.
    /// Once the account's keys are deleted, only the owner can.
    #[payable]
    pub fn upgrade(&mut self) -> Promise {
        self.assert_owner();
        let code = env::input().unwrap_or_else(|| env::panic_str("NoCode"));
        require!(!code.is_empty(), "NoCode");
        emit("upgrade", json!({ "code_sha256": hex::encode(env::sha256_array(&code)) }));
        Promise::new(env::current_account_id()).deploy_contract(code).function_call(
            "migrate".to_string(),
            Vec::new(),
            NearToken::from_yoctonear(0),
            GAS_FOR_MIGRATE,
        )
    }

    /// Run by `upgrade` on the new code. Every release keeps the method.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        env::state_read().unwrap_or_else(|| env::panic_str("NoState"))
    }

    // =============== Views ==================================================================

    pub fn owner(&self) -> &AccountId {
        &self.owner
    }

    pub fn pending_owner(&self) -> Option<&AccountId> {
        self.pending_owner.as_ref()
    }

    pub fn get_config(&self) -> Value {
        json!({
            "mpc_signer": self.mpc_signer,
            "intents": self.intents,
            "core": self.core,
            "emitter_chain": self.emitter_chain,
            "emitter": hex::encode(self.emitter),
            "eth_token": self.eth_token,
            "quote_keys": self.quote_keys.iter().map(|k| format!("ed25519:{}", bs58::encode(k).into_string())).collect::<Vec<_>>(),
            "params": self.params,
        })
    }

    pub fn get_routes(&self) -> &BTreeMap<String, Route> {
        &self.routes
    }

    /// The derivation path of `terms` — what `v1.signer.derived_public_key` takes, with this
    /// account as `predecessor` and `domain_id` 1. Panics on invalid terms.
    pub fn path_of(&self, terms: Base64VecU8) -> String {
        parse_terms(&terms.0);
        path_string(&auth_path(&terms.0))
    }
}

impl IntentRouter {
    /// The derived key and the verifier's salt, joint.
    fn reads(&self, path: &[u8; 32]) -> Promise {
        ext_mpc::ext(self.mpc_signer.clone())
            .with_static_gas(GAS_FOR_DERIVE)
            .derived_public_key(path_string(path), Some(env::current_account_id()), Some(DOMAIN_ED25519))
            .and(ext_intents::ext(self.intents.clone()).with_static_gas(GAS_FOR_SALT).current_salt())
    }

    fn payout(&self, terms: Base64VecU8, payout: Payout) -> Promise {
        near_sdk::assert_one_yocto();
        self.require_gas(GAS_FOR_DERIVE.saturating_add(GAS_FOR_SALT).saturating_add(GAS_FOR_ON_PAYOUT_KEY));
        let t = parse_terms(&terms.0);
        match payout {
            Payout::Deliver => {
                self.route(&t.destination_asset);
            }
            Payout::Refund => require!(now_ms() > t.deadline_ms(), "BeforeDeadline"),
        }
        self.reads(&auth_path(&terms.0)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_ON_PAYOUT_KEY)
                .on_payout_key(terms, payout),
        )
    }

    /// Terms a swap may run under: a supported route, not ETH → ETH.
    fn swap_terms(&self, bytes: &[u8]) -> (Terms, [u8; 32]) {
        let t = parse_terms(bytes);
        require!(t.destination_asset != self.eth_token, "SameAsset");
        self.route(&t.destination_asset);
        (t, auth_path(bytes))
    }

    /// The order the VAA carries, for these terms, still priced at `now_ms` — and when its price
    /// expires: `min(deadline, Hydration block time + price_validity)`.
    fn order(&self, t: &Terms, path: &[u8; 32], vaa: &[u8], now_ms: u64) -> (Order, u64) {
        let vaa = Vaa::parse(vaa).unwrap_or_else(|_| env::panic_str("InvalidVaa"));
        require!(vaa.emitter_chain == self.emitter_chain && vaa.emitter_address == self.emitter, "UnknownEmitter");
        let order = Order::parse(&vaa.payload).unwrap_or_else(|e| env::panic_str(e));
        require!(order.auth_path == *path, "OrderForOtherTerms");
        let priced_until = (u64::from(vaa.timestamp) + self.params.price_validity) * 1_000;
        let expiry = t.deadline_ms().min(priced_until);
        require!(now_ms < expiry, "OrderExpired");
        (order, expiry)
    }

    /// The swap: every check, then a transfer of exactly `amountIn` ETH to the deposit account.
    pub(crate) fn build_swap(&self, terms: &[u8], vaa: &[u8], quote: &Quote, key: [u8; 32], salt: [u8; 4], now_ms: u64) -> Plan {
        let (t, path) = self.swap_terms(terms);
        let (order, order_expiry) = self.order(&t, &path, vaa, now_ms);
        quote::verify(quote, &self.quote_keys).unwrap_or_else(|e| env::panic_str(e));
        let account = implicit_account(&key);
        let q = quote::accept(
            &quote.signed,
            &Expect { account: account.as_str(), origin: &self.eth_token, destination: &t.destination_asset },
        )
        .unwrap_or_else(|e| env::panic_str(e));

        let p = &self.params;
        require!(now_ms <= q.issued_ms.saturating_add(p.max_quote_age * 1_000), "QuoteTooOld");
        require!(q.amount_in <= order.amount.saturating_mul(u128::from(p.max_fill_multiple)), "AboveFillCap");
        require!(floor::meets_rate(q.amount_in, q.min_amount_out, order.out_per_in, t.max_slippage_bps), "BelowFloor");
        require!(floor::meets_hard_floor(q.amount_in, q.min_amount_out, t.min_out_per_in), "BelowHardFloor");

        // Short, so a signed transfer cannot land after its quote; never past the order's price.
        let deadline = now_ms.saturating_add(p.transfer_validity * 1_000).min(order_expiry);
        require!(q.deadline_ms >= deadline, "QuoteDeadlineTooSoon");

        // From the order alone: any quote for the same order re-signs the same nonce, so at most
        // one transfer per order ever executes.
        let nonce = versioned_nonce(salt, order_expiry, entropy(&[b"swap", &path, &order.seq.to_be_bytes()]));
        let message = intent::message(&account, deadline, vec![transfer(q.deposit.as_str(), &self.eth_token, q.amount_in)]);
        let info = Signed {
            action: "swap".into(),
            account,
            auth_path: path_string(&path),
            seq: Some(order.seq),
            token: self.eth_token.clone(),
            amount: U128(q.amount_in),
            min_amount_out: Some(U128(q.min_amount_out)),
            receiver: q.deposit.to_string(),
        };
        Plan { path, key, message, nonce, info }
    }

    /// A delivery or refund of `A`'s whole `balance`, to where the terms say.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn build_payout(
        &self,
        terms: &[u8],
        payout: Payout,
        key: [u8; 32],
        salt: [u8; 4],
        balance: u128,
        now_ms: u64,
        height: u64,
    ) -> Plan {
        let t = parse_terms(terms);
        let path = auth_path(terms);
        let account = implicit_account(&key);
        let past = now_ms > t.deadline_ms();

        let (action, token, receiver, intent) = match payout {
            Payout::Refund => {
                require!(past, "BeforeDeadline");
                require!(balance > 0 && balance >= self.params.min_refund.0, "NothingToRefund");
                let contract = token_contract(&self.eth_token);
                let to = eip55(&t.refund_to);
                let intent = ft_withdraw(contract.as_str(), contract.as_str(), balance, Some(format!("{WITHDRAW_TO}{to}")));
                ("refund", self.eth_token.clone(), to, intent)
            }
            Payout::Deliver => {
                let route = self.route(&t.destination_asset);
                let min = if past { route.min_withdraw.0 } else { route.min_delivery.0 };
                require!(balance > 0 && balance >= min, "NothingToDeliver");
                let intent = match t.recipient_kind {
                    RecipientKind::Withdraw => {
                        let contract = token_contract(&t.destination_asset);
                        ft_withdraw(contract.as_str(), contract.as_str(), balance, Some(format!("{WITHDRAW_TO}{}", t.recipient)))
                    }
                    RecipientKind::Intents => transfer(&t.recipient, &t.destination_asset, balance),
                };
                ("deliver", t.destination_asset.clone(), t.recipient.clone(), intent)
            }
        };

        let deadline = now_ms.saturating_add(self.params.transfer_validity * 1_000);
        let nonce = versioned_nonce(
            salt,
            deadline,
            entropy(&[action.as_bytes(), &path, &height.to_be_bytes(), &balance.to_be_bytes()]),
        );
        let message = intent::message(&account, deadline, vec![intent]);
        let info = Signed {
            action: action.into(),
            account,
            auth_path: path_string(&path),
            seq: None,
            token,
            amount: U128(balance),
            min_amount_out: None,
            receiver,
        };
        Plan { path, key, message, nonce, info }
    }

    fn sign(&self, plan: Plan) -> Promise {
        let digest = nep413_digest(&plan.message, &plan.nonce, self.intents.as_str());
        let request = SignRequest {
            path: path_string(&plan.path),
            payload_v2: Payload::Eddsa(hex::encode(digest)),
            domain_id: DOMAIN_ED25519,
        };
        ext_mpc::ext(self.mpc_signer.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_SIGN)
            .sign(request)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_SIGNED)
                    .on_signed(plan.message, hex::encode(plan.nonce), hex::encode(plan.key), plan.info),
            )
    }

    fn route(&self, asset: &str) -> &Route {
        self.routes.get(asset).unwrap_or_else(|| env::panic_str("UnsupportedRoute"))
    }

    fn require_gas(&self, needed: Gas) {
        require!(env::prepaid_gas().saturating_sub(env::used_gas()) >= needed, "NotEnoughGas");
    }

    fn assert_owner(&self) {
        near_sdk::assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "Unauthorized");
    }

    fn assert_params(&self) {
        let p = &self.params;
        require!(p.price_validity > 0 && p.price_validity <= MAX_PRICE_VALIDITY, "InvalidPriceValidity");
        require!(p.max_quote_age > 0 && p.max_quote_age <= MAX_QUOTE_AGE, "InvalidQuoteAge");
        require!(p.transfer_validity > 0 && p.transfer_validity <= MAX_TRANSFER_VALIDITY, "InvalidTransferValidity");
        require!(p.max_fill_multiple > 0 && p.max_fill_multiple <= MAX_FILL_MULTIPLE, "InvalidFillMultiple");
        require!(p.min_refund.0 > 0, "InvalidMinRefund");
    }
}

/// NEP-297 event, standard `whm-intent-router`.
pub(crate) fn emit(event: &str, data: Value) {
    let log = json!({ "standard": "whm-intent-router", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

/// Block time, unix ms.
fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

fn parse_terms(bytes: &[u8]) -> Terms {
    Terms::parse(bytes).unwrap_or_else(|e| env::panic_str(e))
}

/// `nep141:<contract>` → the contract.
fn token_contract(ledger_id: &str) -> AccountId {
    ledger_id
        .strip_prefix(NEP141)
        .and_then(|c| c.parse().ok())
        .unwrap_or_else(|| env::panic_str("UnsupportedToken"))
}

fn parse_quote_keys(keys: &[String]) -> Vec<[u8; 32]> {
    require!(!keys.is_empty(), "NoQuoteKeys");
    keys.iter().map(|k| quote::parse_key(k).unwrap_or_else(|e| env::panic_str(e))).collect()
}

fn parse_salt(value: &str) -> [u8; 4] {
    let bytes = hex::decode(value).unwrap_or_else(|_| env::panic_str("InvalidSalt"));
    bytes.try_into().unwrap_or_else(|_| env::panic_str("InvalidSalt"))
}

use near_common::parse_bytes32 as parse_hex32;

#[cfg(test)]
mod tests;
