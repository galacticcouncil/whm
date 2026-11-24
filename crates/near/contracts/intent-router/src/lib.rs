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
//!        → on_swap_reads: A known → intents.mt_balance_of(A, eth)
//!             → on_swap_balance: order, 1Click quote, fill size and floor checked
//!                  → v1.signer.sign(a transfer of amountIn ETH from A to the quote's deposit account)
//!                       → on_signed: emit the MultiPayload
//! deliver(terms) | refund(terms)
//!   ├─ derived_public_key(path) ┐ joint
//!   └─ current_salt()           ┘
//!        → on_payout_key: intents.mt_balance_of(A, token)
//!             → on_payout_balance: A's whole balance to the terms' recipient | refundTo → sign → on_signed
//!          — a delivery on a UTXO route also derives A_utxo beside the balance read → on_payout_utxo
//! settle(terms, close_vaa)
//!   ├─ derived_public_key(path) ┐
//!   ├─ current_salt()           │ joint
//!   └─ core.verify_vaa(close)   ┘
//!        → on_settle_reads: intents.mt_balance_of(A, eth) ┐ joint
//!                           intents.mt_balance_of(A, dest) ┘
//!             → on_settle_balances: a delivery and a refund, each its own payload → sign → on_signed
//!          — on a UTXO route, A_utxo derived beside them → on_settle_utxo
//! ```
//!
//! **Withdrawals go through UTXO routes.** A withdrawal of a token with a route, to an address it
//! accepts, goes to `A_utxo` — the account the route's withdraw contract derives from the address —
//! as a plain NEP-141 balance; that contract takes it to the coin's own chain through Omni's
//! connector. wNEAR is unwrapped to native NEAR. Nothing else withdraws: such terms never swap and
//! their ETH is refunded, and output below the route's minimum waits in `A`. POA carries only the
//! ETH refunds.
//!
//! Nothing is stored per account. Anyone may call; the bot publishes what is signed.
//!
//! **The invariant.** Every path to `sign` builds its payload only from the terms (bound to `A` by
//! the hash), a verified order or close message, a quote 1Click signed, the clock and balance reads —
//! and only one of three: a transfer to the deposit account of a quote that pays and refunds `A`, at
//! or above the order's floor; `A`'s destination asset to the terms' recipient — directly, or through
//! the `A_utxo` its address derives under an owner-set route; after the deadline or
//! a close's countdown, `A`'s ETH to the terms' `refundTo`. No admin sign, no generic
//! `sign(payload)`, no public callback.

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

use intent::{eip55, entropy, ft_withdraw, multi_payload, native_withdraw, nep413_digest, transfer, versioned_nonce};
use mpc::{ext_mpc, implicit_account, parse_ed25519, Payload, SignRequest, SignatureResponse, DOMAIN_ED25519};
use order::{Close, Order};
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
/// `on_swap_balance`'s own work — the quote's JSON, hash and signature — then the sign it schedules.
pub const GAS_FOR_ON_SWAP_BALANCE: Gas = Gas::from_tgas(20 + 30 + 10);
/// `on_swap_reads`' own work, the balance read and `on_swap_balance`.
pub const GAS_FOR_ON_SWAP_READS: Gas = Gas::from_tgas(10 + 5 + 60);
/// `on_payout_balance`'s own work, then the sign it schedules.
pub const GAS_FOR_ON_PAYOUT_BALANCE: Gas = Gas::from_tgas(15 + 30 + 10);
/// `on_payout_key`'s own work, the balance read, a UTXO route's derive and `on_payout_balance`.
pub const GAS_FOR_ON_PAYOUT_KEY: Gas = Gas::from_tgas(10 + 5 + 10 + 55);
/// `on_settle_balances`' own work, then the two signs it may schedule.
pub const GAS_FOR_ON_SETTLE_BALANCES: Gas = Gas::from_tgas(15 + 2 * (30 + 10));
/// `on_settle_reads`' own work, the two balance reads, a UTXO route's derive and `on_settle_balances`.
pub const GAS_FOR_ON_SETTLE_READS: Gas = Gas::from_tgas(10 + 2 * 5 + 10 + 95);

/// `migrate` on the new code, in the same batch as its deploy.
pub const GAS_FOR_MIGRATE: Gas = Gas::from_tgas(50);

/// Upper bounds on the timing params, seconds.
pub const MAX_PRICE_VALIDITY: u64 = 86_400;
pub const MAX_QUOTE_AGE: u64 = 600;
pub const MAX_TRANSFER_VALIDITY: u64 = 600;
/// Upper bound on `min_quote_slippage_bps` — above it a quote's guaranteed output sits too far below
/// its price for a sane floor to accept.
pub const MAX_MIN_QUOTE_SLIPPAGE_BPS: u16 = 1_000;
/// Upper bound on `max_order_shortfall_bps` — a hedge for POA's credit, never so loose that a
/// stranger's dust passes for an order's arrival.
pub const MAX_ORDER_SHORTFALL_BPS: u16 = 500;
/// Upper bound on `min_refund`, wei — 0.01 ETH, well above POA's withdrawal fee; a refund
/// threshold above it would let config hold users' ETH.
pub const MAX_MIN_REFUND: u128 = 10_000_000_000_000_000;

/// A fill may be this far below `min(A's ETH, cap)`: the quote is fetched a moment before the
/// router reads the balance, and a stranger crediting `A` a few wei in between must not void it.
pub const FILL_TOLERANCE_BPS: u128 = 100;

/// The `v1.signer` deposit.
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// The NEP-141 prefix of an intents ledger id; the rest is the token contract.
const NEP141: &str = "nep141:";

/// The memo POA's bridge tokens read the destination address from — the ETH refund's.
const WITHDRAW_TO: &str = "WITHDRAW_TO:";

/// wNEAR's ledger id. A withdrawal of it is no POA bridge: it is unwrapped and paid as native NEAR to
/// the recipient's NEAR account, as 1Click pays NEAR.
const WNEAR: &str = "nep141:wrap.near";

/// Storage key of the UTXO routes — beside the contract state, not in it, so its layout is unchanged.
const UTXO_ROUTES: &[u8] = b"utxo_routes";

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
    /// The least slippage tolerance a quote may have been requested with, bps. A quote with no room
    /// to fill is one 1Click refunds, and it would spend the order's one fill for nothing; the floor,
    /// not this, bounds the price.
    pub min_quote_slippage_bps: u16,
    /// Seconds a signed transfer stays executable.
    pub transfer_validity: u64,
    /// How far below the order's own amount `A`'s ETH may be and still count as credited, bps. The
    /// amount is already net of the relay fee and trimming, so this covers only POA's credit
    /// falling short of the deposit — a hedge, small or 0, at most `MAX_ORDER_SHORTFALL_BPS`.
    pub max_order_shortfall_bps: u16,
    /// The smallest ETH refund, wei — above POA's withdrawal fee. At most `MAX_MIN_REFUND`.
    pub min_refund: U128,
}

/// How a token's withdrawals reach its own chain without POA: through the withdraw contract that
/// derives `A_utxo` from the address, Omni's connector behind it. Generic over the coin — a new chain
/// is a new withdraw contract and a route, no router change.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct UtxoRoute {
    /// The withdraw contract, e.g. `withdraw-zec.hydration-whm.near` — the `predecessor` of `A_utxo`.
    pub withdraw: AccountId,
    /// Its derivation path prefix; `A_utxo`'s path is this plus the address, e.g. `zcash:v1:t1…`.
    pub path_prefix: String,
    /// Address prefixes it withdraws to, e.g. `["t1", "t3"]`; any other address goes through POA.
    pub address_prefixes: Vec<String>,
    /// The least that goes this way — the connector's minimum withdrawal; less goes through POA.
    pub min_amount: U128,
}

#[near(serializers = [json])]
pub enum Payout {
    Deliver,
    Refund,
}

/// `A_utxo`, with the route it was derived under: a delivery goes to it only while that route is
/// still the token's.
pub(crate) type UtxoAccount = (AccountId, UtxoRoute);

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
    /// A delivery on a UTXO route: the `A_utxo` it goes to, for the withdraw contract to send on.
    pub utxo_account: Option<String>,
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
    /// Hydration's Wormhole chain id, 73, and `IntentDispatcher`.
    emitter_chain: u16,
    emitter: [u8; 32],
    /// What `A` is credited and sells: `nep141:eth.omft.near`.
    eth_token: String,

    /// 1Click's quote-signing keys. A quote signed by any of them verifies, so a rotation announced
    /// in advance has no gap.
    quote_keys: Vec<[u8; 32]>,
    params: Params,
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
        };
        this.assert_params();
        this
    }

    // =============== Signing ================================================================

    /// Signs `A`'s transfer of the quote's `amountIn` ETH to 1Click's deposit account — the swap.
    /// The order message prices it; the quote, signed by 1Click, must pay and refund `A` at or above
    /// that price, for `A`'s whole ETH up to the fill cap — never a size the caller picks. One fill
    /// per order. Anyone may call, with 1 yocto — the signer's deposit.
    #[payable]
    pub fn swap(&mut self, terms: Base64VecU8, order_vaa: Base64VecU8, quote: Quote) -> Promise {
        near_sdk::assert_one_yocto();
        self.require_gas(
            GAS_FOR_DERIVE.saturating_add(GAS_FOR_SALT).saturating_add(GAS_FOR_VERIFY).saturating_add(GAS_FOR_ON_SWAP_READS),
        );
        // Fail fast on everything checkable before the reads; on_swap_balance checks it all again.
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
    /// deadline only once it reaches the terms' `minDelivery`; after it, any balance.
    #[payable]
    pub fn deliver(&mut self, terms: Base64VecU8) -> Promise {
        self.payout(terms, Payout::Deliver)
    }

    /// After the deadline, signs the withdrawal of `A`'s whole ETH balance to the terms' `refundTo`
    /// on Ethereum. Its one setting, `min_refund`, is capped at `MAX_MIN_REFUND`.
    #[payable]
    pub fn refund(&mut self, terms: Base64VecU8) -> Promise {
        self.payout(terms, Payout::Refund)
    }

    /// Once the owner has closed the terms on Hydration and the close's countdown has run, signs what
    /// `A` holds out — its destination balance to the recipient, `minDelivery` aside, and its ETH from
    /// `min_refund` up to `refundTo` — each its own payload, a delivery and a refund as after the
    /// deadline, so one the verifier refuses cannot hold the other. Nothing in them is the caller's —
    /// no quote, no amount, no destination — so anyone may call, any time after, with 1 yocto: each
    /// call moves what `A` holds then, so what lands late leaves with the next one.
    #[payable]
    pub fn settle(&mut self, terms: Base64VecU8, close_vaa: Base64VecU8) -> Promise {
        near_sdk::assert_one_yocto();
        self.require_gas(
            GAS_FOR_DERIVE.saturating_add(GAS_FOR_SALT).saturating_add(GAS_FOR_VERIFY).saturating_add(GAS_FOR_ON_SETTLE_READS),
        );
        // Fail fast on everything checkable before the reads; on_settle_balances checks it all again.
        parse_terms(&terms.0);
        let path = auth_path(&terms.0);
        self.close(&path, &close_vaa.0, now_ms());

        self.reads(&path)
            .and(ext_wormhole::ext(self.core.clone()).with_static_gas(GAS_FOR_VERIFY).verify_vaa(hex::encode(&close_vaa.0)))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_SETTLE_READS)
                    .on_settle_reads(terms, close_vaa),
            )
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
        ext_intents::ext(self.intents.clone())
            .with_static_gas(GAS_FOR_BALANCE)
            .mt_balance_of(implicit_account(&key), self.eth_token.clone())
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_SWAP_BALANCE)
                    .on_swap_balance(terms, order_vaa, quote, hex::encode(key), hex::encode(salt)),
            )
    }

    #[private]
    pub fn on_swap_balance(
        &mut self,
        terms: Base64VecU8,
        order_vaa: Base64VecU8,
        quote: Quote,
        key: String,
        salt: String,
        #[callback_result] balance: Result<U128, PromiseError>,
    ) -> Promise {
        let balance = balance.unwrap_or_else(|_| env::panic_str("BalanceReadFailed")).0;
        let plan = self.build_swap(&terms.0, &order_vaa.0, &quote, parse_hex32(&key), parse_salt(&salt), balance, now_ms());
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
        let route = match payout {
            Payout::Deliver => self.utxo_route(&t),
            Payout::Refund => None,
        };
        let token = match payout {
            Payout::Deliver => t.destination_asset.clone(),
            Payout::Refund => self.eth_token.clone(),
        };
        let balance = ext_intents::ext(self.intents.clone())
            .with_static_gas(GAS_FOR_BALANCE)
            .mt_balance_of(implicit_account(&key), token);
        if let Some(route) = route {
            return balance.and(self.derive_utxo(&route, &t.recipient)).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_PAYOUT_BALANCE)
                    .on_payout_utxo(terms, hex::encode(key), hex::encode(salt), route),
            );
        }
        balance
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
        let plan = self.build_payout(&terms.0, payout, parse_hex32(&key), parse_salt(&salt), balance, now_ms(), env::block_height(), None);
        self.sign(plan)
    }

    /// [`Self::on_payout_balance`] for a delivery on a UTXO route, with `A_utxo`'s derived key and
    /// the route it was derived under.
    #[private]
    pub fn on_payout_utxo(
        &mut self,
        terms: Base64VecU8,
        key: String,
        salt: String,
        route: UtxoRoute,
        #[callback_result] balance: Result<U128, PromiseError>,
        #[callback_result] utxo_key: Result<String, PromiseError>,
    ) -> Promise {
        let balance = balance.unwrap_or_else(|_| env::panic_str("BalanceReadFailed")).0;
        let utxo = implicit_account(&parse_ed25519(&utxo_key.unwrap_or_else(|_| env::panic_str("DeriveFailed"))));
        let plan = self.build_payout(
            &terms.0,
            Payout::Deliver,
            parse_hex32(&key),
            parse_salt(&salt),
            balance,
            now_ms(),
            env::block_height(),
            Some((utxo, route)),
        );
        self.sign(plan)
    }

    #[private]
    pub fn on_settle_reads(
        &mut self,
        terms: Base64VecU8,
        close_vaa: Base64VecU8,
        #[callback_result] key: Result<String, PromiseError>,
        #[callback_result] salt: Result<String, PromiseError>,
        #[callback_result] verified: Result<u32, PromiseError>,
    ) -> Promise {
        let key = parse_ed25519(&key.unwrap_or_else(|_| env::panic_str("DeriveFailed")));
        let salt = parse_salt(&salt.unwrap_or_else(|_| env::panic_str("SaltReadFailed")));
        require!(verified.is_ok(), "VaaVerifyFailed");
        let t = parse_terms(&terms.0);
        let account = implicit_account(&key);
        let balance = |token: String| {
            ext_intents::ext(self.intents.clone()).with_static_gas(GAS_FOR_BALANCE).mt_balance_of(account.clone(), token)
        };
        let reads = balance(self.eth_token.clone()).and(balance(t.destination_asset.clone()));
        if let Some(route) = self.utxo_route(&t) {
            return reads.and(self.derive_utxo(&route, &t.recipient)).then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_SETTLE_BALANCES)
                    .on_settle_utxo(terms, close_vaa, hex::encode(key), hex::encode(salt), route),
            );
        }
        reads
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_SETTLE_BALANCES)
                    .on_settle_balances(terms, close_vaa, hex::encode(key), hex::encode(salt)),
            )
    }

    #[private]
    pub fn on_settle_balances(
        &mut self,
        terms: Base64VecU8,
        close_vaa: Base64VecU8,
        key: String,
        salt: String,
        #[callback_result] eth: Result<U128, PromiseError>,
        #[callback_result] out: Result<U128, PromiseError>,
    ) -> Promise {
        // A read that failed — a destination id the verifier cannot parse — has nothing to move.
        let plans = self.build_settle(
            &terms.0,
            &close_vaa.0,
            parse_hex32(&key),
            parse_salt(&salt),
            eth.map_or(0, |b| b.0),
            out.map_or(0, |b| b.0),
            now_ms(),
            env::block_height(),
            None,
        );
        self.sign_all(plans)
    }

    /// [`Self::on_settle_balances`] on a UTXO route, with `A_utxo`'s derived key and the route it was
    /// derived under. A failed derive costs only the delivery: the refund needs no `A_utxo`.
    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn on_settle_utxo(
        &mut self,
        terms: Base64VecU8,
        close_vaa: Base64VecU8,
        key: String,
        salt: String,
        route: UtxoRoute,
        #[callback_result] eth: Result<U128, PromiseError>,
        #[callback_result] out: Result<U128, PromiseError>,
        #[callback_result] utxo_key: Result<String, PromiseError>,
    ) -> Promise {
        let utxo = utxo_key.ok().map(|k| (implicit_account(&parse_ed25519(&k)), route));
        let plans = self.build_settle(
            &terms.0,
            &close_vaa.0,
            parse_hex32(&key),
            parse_salt(&salt),
            eth.map_or(0, |b| b.0),
            out.map_or(0, |b| b.0),
            now_ms(),
            env::block_height(),
            utxo,
        );
        self.sign_all(plans)
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
            "utxo_account": info.utxo_account,
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

    /// Sets or, with `None`, removes the UTXO route of a token, by intents ledger id
    /// (`nep141:zec.omft.near`). Applies from the next payout, running trades too.
    #[payable]
    pub fn set_utxo_route(&mut self, token: String, route: Option<UtxoRoute>) {
        self.assert_owner();
        token_contract(&token);
        require!(token != self.eth_token && token != WNEAR, "UnsupportedToken");
        let mut routes = stored_utxo_routes();
        match &route {
            Some(r) => {
                require!(!r.path_prefix.is_empty(), "InvalidPathPrefix");
                require!(
                    !r.address_prefixes.is_empty() && r.address_prefixes.iter().all(|p| !p.is_empty()),
                    "InvalidAddressPrefixes"
                );
                require!(r.min_amount.0 > 0, "InvalidMinAmount");
                routes.insert(token.clone(), r.clone());
            }
            None => {
                routes.remove(&token);
            }
        }
        env::storage_write(UTXO_ROUTES, &near_sdk::borsh::to_vec(&routes).unwrap());
        emit("utxo_route_set", json!({ "token": token, "route": route }));
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
        let code_sha256 = hex::encode(env::sha256_array(&code));
        Promise::new(env::current_account_id()).deploy_contract(code).function_call(
            "migrate".to_string(),
            json!({ "code_sha256": code_sha256 }).to_string().into_bytes(),
            NearToken::from_yoctonear(0),
            GAS_FOR_MIGRATE,
        )
    }

    /// Run by `upgrade` on the new code. Every release keeps the method and its argument. The
    /// upgrade is logged here, in the deploy's own receipt, so a refused migrate logs nothing.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(code_sha256: String) -> Self {
        let this: Self = env::state_read().unwrap_or_else(|| env::panic_str("NoState"));
        // A release that changes the bounds re-checks the stored params against them.
        this.assert_params();
        emit("upgrade", json!({ "code_sha256": code_sha256 }));
        this
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

    /// Every UTXO route, by intents ledger id.
    pub fn utxo_routes(&self) -> BTreeMap<String, UtxoRoute> {
        stored_utxo_routes()
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

    /// The route a delivery of these terms takes, if any: a withdrawal of a routed token to an address
    /// the route accepts. Its minimum is checked against the balance, later.
    fn utxo_route(&self, t: &Terms) -> Option<UtxoRoute> {
        if t.recipient_kind != RecipientKind::Withdraw {
            return None;
        }
        stored_utxo_routes()
            .remove(&t.destination_asset)
            .filter(|r| r.address_prefixes.iter().any(|p| t.recipient.starts_with(p.as_str())))
    }

    /// Whether the terms' destination can be delivered at all: a withdrawal of wNEAR to a NEAR
    /// account, or of a token through its UTXO route to an address the route accepts; a transfer to
    /// a valid intents account id. Checked at swap and delivery, never at parse: terms that fail it
    /// must still refund.
    fn is_deliverable(&self, t: &Terms) -> bool {
        match t.recipient_kind {
            RecipientKind::Withdraw if t.destination_asset == WNEAR => t.recipient_account().is_some(),
            RecipientKind::Withdraw => t.token_contract().is_some() && self.utxo_route(t).is_some(),
            RecipientKind::Intents => t.recipient_account().is_some(),
        }
    }

    /// [`Self::is_deliverable`], as a requirement.
    fn deliverable(&self, t: &Terms) {
        let error = match t.recipient_kind {
            RecipientKind::Withdraw if t.destination_asset != WNEAR => "NotWithdrawable",
            _ => "InvalidRecipient",
        };
        require!(self.is_deliverable(t), error);
    }

    /// Whether a settle can deliver `amount` now: deliverable terms, and a withdrawal at its route's
    /// minimum — less waits in `A`.
    fn can_deliver(&self, t: &Terms, amount: u128) -> bool {
        self.is_deliverable(t) && self.utxo_route(t).is_none_or(|r| amount >= r.min_amount.0)
    }

    /// `A_utxo`'s key: the withdraw contract's derivation for the address.
    fn derive_utxo(&self, route: &UtxoRoute, address: &str) -> Promise {
        ext_mpc::ext(self.mpc_signer.clone()).with_static_gas(GAS_FOR_DERIVE).derived_public_key(
            format!("{}{address}", route.path_prefix),
            Some(route.withdraw.clone()),
            Some(DOMAIN_ED25519),
        )
    }

    /// One sign is returned; the others run beside it — a joint promise cannot be returned, and each
    /// emits its own event.
    fn sign_all(&self, plans: Vec<Plan>) -> Promise {
        let mut signs: Vec<Promise> = plans.into_iter().map(|plan| self.sign(plan)).collect();
        signs.pop().unwrap_or_else(|| env::panic_str("NothingToSettle"))
    }

    fn payout(&self, terms: Base64VecU8, payout: Payout) -> Promise {
        near_sdk::assert_one_yocto();
        self.require_gas(GAS_FOR_DERIVE.saturating_add(GAS_FOR_SALT).saturating_add(GAS_FOR_ON_PAYOUT_KEY));
        let t = parse_terms(&terms.0);
        match payout {
            Payout::Deliver => self.deliverable(&t),
            Payout::Refund => require!(now_ms() > t.deadline_ms(), "BeforeDeadline"),
        }
        self.reads(&auth_path(&terms.0)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_ON_PAYOUT_KEY)
                .on_payout_key(terms, payout),
        )
    }

    /// Terms a swap may run under: not ETH → ETH, and a destination their delivery can move. Whether
    /// the asset can be bought at all is 1Click's: no quote, no swap — the ETH waits for a refund.
    fn swap_terms(&self, bytes: &[u8]) -> (Terms, [u8; 32]) {
        let t = parse_terms(bytes);
        require!(t.destination_asset != self.eth_token, "SameAsset");
        self.deliverable(&t);
        (t, auth_path(bytes))
    }

    /// The order the VAA carries, for these terms, still priced at `now_ms` — when its price expires,
    /// `min(deadline, Hydration block time + price_validity)` — and its nonce's expiry, the same
    /// from `MAX_PRICE_VALIDITY` instead: fixed by the order alone, so no param change re-signs it.
    fn order(&self, t: &Terms, path: &[u8; 32], vaa: &[u8], now_ms: u64) -> (Order, u64, u64) {
        let vaa = Vaa::parse(vaa).unwrap_or_else(|_| env::panic_str("InvalidVaa"));
        require!(vaa.emitter_chain == self.emitter_chain && vaa.emitter_address == self.emitter, "UnknownEmitter");
        let order = Order::parse(&vaa.payload).unwrap_or_else(|e| env::panic_str(e));
        require!(order.auth_path == *path, "OrderForOtherTerms");
        let priced_until = (u64::from(vaa.timestamp) + self.params.price_validity) * 1_000;
        let expiry = t.deadline_ms().min(priced_until);
        require!(now_ms < expiry, "OrderExpired");
        let nonce_expiry = t.deadline_ms().min((u64::from(vaa.timestamp) + MAX_PRICE_VALIDITY) * 1_000);
        (order, expiry, nonce_expiry)
    }

    /// The close the VAA carries is for these terms, and its countdown — from its Hydration block
    /// time — has run.
    fn close(&self, path: &[u8; 32], vaa: &[u8], now_ms: u64) {
        let vaa = Vaa::parse(vaa).unwrap_or_else(|_| env::panic_str("InvalidVaa"));
        require!(vaa.emitter_chain == self.emitter_chain && vaa.emitter_address == self.emitter, "UnknownEmitter");
        let close = Close::parse(&vaa.payload).unwrap_or_else(|e| env::panic_str(e));
        require!(close.auth_path == *path, "CloseForOtherTerms");
        let settles_ms = u64::from(vaa.timestamp).saturating_add(close.delay).saturating_mul(1_000);
        require!(now_ms >= settles_ms, "SettleNotYet");
    }

    /// The settle: a delivery of `A`'s destination balance, unless the terms cannot deliver it — or it
    /// is the ETH itself, below the route's minimum, or a withdrawal without an `A_utxo` derived under
    /// the current route — and a refund of its ETH from `min_refund` up; each as after the deadline,
    /// the close standing in for it.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn build_settle(
        &self,
        terms: &[u8],
        vaa: &[u8],
        key: [u8; 32],
        salt: [u8; 4],
        eth: u128,
        out: u128,
        now_ms: u64,
        height: u64,
        utxo: Option<UtxoAccount>,
    ) -> Vec<Plan> {
        let t = parse_terms(terms);
        self.close(&auth_path(terms), vaa, now_ms);
        let mut plans = Vec::new();
        let utxo_ready = match self.utxo_route(&t) {
            Some(route) => utxo.as_ref().is_some_and(|(_, derived)| *derived == route),
            None => true,
        };
        if out > 0 && t.destination_asset != self.eth_token && self.can_deliver(&t, out) && utxo_ready {
            plans.push(self.payout_plan(terms, Payout::Deliver, key, salt, out, now_ms, height, true, utxo));
        }
        if eth > 0 && eth >= self.params.min_refund.0 {
            plans.push(self.payout_plan(terms, Payout::Refund, key, salt, eth, now_ms, height, true, None));
        }
        require!(!plans.is_empty(), "NothingToSettle");
        plans
    }

    /// The swap: every check, then a transfer of exactly `amountIn` ETH to the deposit account.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn build_swap(
        &self,
        terms: &[u8],
        vaa: &[u8],
        quote: &Quote,
        key: [u8; 32],
        salt: [u8; 4],
        balance: u128,
        now_ms: u64,
    ) -> Plan {
        let (t, path) = self.swap_terms(terms);
        let (order, order_expiry, nonce_expiry) = self.order(&t, &path, vaa, now_ms);
        quote::verify(quote, &self.quote_keys).unwrap_or_else(|e| env::panic_str(e));
        let account = implicit_account(&key);
        let q = quote::accept(
            &quote.signed,
            &Expect { account: account.as_str(), origin: &self.eth_token, destination: &t.destination_asset },
        )
        .unwrap_or_else(|e| env::panic_str(e));

        let p = &self.params;
        require!(now_ms <= q.issued_ms.saturating_add(p.max_quote_age * 1_000), "QuoteTooOld");
        require!(q.slippage_bps >= u64::from(p.min_quote_slippage_bps), "QuoteSlippageTooTight");
        // The fill is A's whole ETH up to the cap, not the caller's choice: a dust quote cannot
        // spend the order's one nonce. And A must hold about the order's amount, so dust a stranger
        // credits before POA does cannot qualify — though ETH A already held counts as well as this
        // order's own: the check cannot tell them apart.
        let fill = balance.min(order.amount.saturating_mul(u128::from(t.max_fill_multiplier)));
        require!(
            q.amount_in <= fill && q.amount_in * 10_000 >= fill * (10_000 - FILL_TOLERANCE_BPS),
            "WrongFillAmount"
        );
        require!(
            balance * 10_000 >= order.amount * u128::from(10_000 - p.max_order_shortfall_bps),
            "OrderNotCredited"
        );
        require!(floor::meets_rate(q.amount_in, q.min_amount_out, order.out_per_in, t.max_slippage_bps), "BelowFloor");
        require!(floor::meets_hard_floor(q.amount_in, q.min_amount_out, t.min_out_per_in), "BelowHardFloor");

        // Short, so a signed transfer cannot land after its quote; never past the order's price.
        let deadline = now_ms.saturating_add(p.transfer_validity * 1_000).min(order_expiry);
        require!(q.deadline_ms >= deadline, "QuoteDeadlineTooSoon");

        // From the order alone: any quote for the same order re-signs the same nonce, so at most one
        // transfer per order executes. The salt is the verifier's live one: after a salt rotation,
        // while the old salt is still accepted, an order can be signed once more — a second fill of
        // what A still holds, sized and floored as above, under its own cap: the cap is per salt.
        let nonce = versioned_nonce(salt, nonce_expiry, entropy(&[b"swap", &path, &order.seq.to_be_bytes()]));
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
            utxo_account: None,
        };
        Plan { path, key, message, nonce, info }
    }

    /// A delivery or refund of `A`'s whole `balance`, to where the terms say — `utxo` being `A_utxo`
    /// when the delivery's UTXO route derived it.
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
        utxo: Option<UtxoAccount>,
    ) -> Plan {
        self.payout_plan(terms, payout, key, salt, balance, now_ms, height, false, utxo)
    }

    /// [`Self::build_payout`], `closed` when a verified close's countdown has run — which lets the
    /// payout through as the deadline would. A withdrawal goes to `utxo`, from the route's minimum, and
    /// only if `utxo` was derived under the route the token has now.
    #[allow(clippy::too_many_arguments)]
    fn payout_plan(
        &self,
        terms: &[u8],
        payout: Payout,
        key: [u8; 32],
        salt: [u8; 4],
        balance: u128,
        now_ms: u64,
        height: u64,
        closed: bool,
        utxo: Option<UtxoAccount>,
    ) -> Plan {
        let t = parse_terms(terms);
        let path = auth_path(terms);
        let account = implicit_account(&key);
        let past = closed || now_ms > t.deadline_ms();

        let mut utxo_account = None;
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
                self.deliverable(&t);
                let min = if past { 1 } else { t.min_delivery.max(1) };
                require!(balance >= min, "NothingToDeliver");
                let intent = match t.recipient_kind {
                    RecipientKind::Withdraw if t.destination_asset == WNEAR => native_withdraw(&t.recipient, balance),
                    RecipientKind::Withdraw => {
                        let route = self.utxo_route(&t).unwrap_or_else(|| env::panic_str("NotWithdrawable"));
                        require!(balance >= route.min_amount.0, "BelowRouteMinimum");
                        let (a_utxo, derived) = utxo.unwrap_or_else(|| env::panic_str("NoUtxoAccount"));
                        require!(derived == route, "RouteChanged");
                        let contract = t.token_contract().unwrap_or_else(|| env::panic_str("NotWithdrawable"));
                        utxo_account = Some(a_utxo.to_string());
                        ft_withdraw(contract.as_str(), a_utxo.as_str(), balance, None)
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
            utxo_account,
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
        require!(p.min_quote_slippage_bps <= MAX_MIN_QUOTE_SLIPPAGE_BPS, "InvalidQuoteSlippage");
        require!(p.transfer_validity > 0 && p.transfer_validity <= MAX_TRANSFER_VALIDITY, "InvalidTransferValidity");
        require!(p.max_order_shortfall_bps <= MAX_ORDER_SHORTFALL_BPS, "InvalidOrderShortfall");
        require!(p.min_refund.0 > 0 && p.min_refund.0 <= MAX_MIN_REFUND, "InvalidMinRefund");
    }
}

/// NEP-297 event, standard `whm-intent-router`.
pub(crate) fn emit(event: &str, data: Value) {
    let log = json!({ "standard": "whm-intent-router", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

/// The UTXO routes, by intents ledger id.
fn stored_utxo_routes() -> BTreeMap<String, UtxoRoute> {
    env::storage_read(UTXO_ROUTES)
        .map(|b| near_sdk::borsh::from_slice(&b).unwrap_or_else(|_| env::panic_str("InvalidUtxoRoutes")))
        .unwrap_or_default()
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
