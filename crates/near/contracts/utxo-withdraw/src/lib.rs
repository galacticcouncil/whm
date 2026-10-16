//! UTXO withdraw — sends a UTXO-chain token on NEAR (`zec.omft.near`) to its native chain through
//! Omni's connector, from an account derived from the destination address. Design:
//! `docs/near-utxo/withdraw.md`.
//!
//! ```text
//! terms = the destination address    path = chain prefix + address    A = v1.signer key for (self, path)
//!
//! withdraw(address, coin)
//!   → v1.signer.derived_public_key(path)
//!        → on_key: A
//!             ├─ token.ft_balance_of(A)           ┐
//!             ├─ connector.get_config()           │ joint
//!             └─ connector.list_utxos([coin])     ┘
//!                  → on_reads: the whole transaction, every number computed here
//!                       → v1.signer.sign(sha256 of the delegate action)
//!                            → on_signed: emit the SignedDelegateAction
//! claim(address)
//!   → derived_public_key → on_key → connector.list_lost_found([A])
//!        → on_lost_found: only if A has an entry, the claim_lost_found delegate → sign → on_signed
//! ```
//!
//! Nothing is stored per account and nothing is held: the contract only signs, for `A`, one of two
//! fixed delegate actions. Anyone may call; a relayer submits the result and pays its gas.
//!
//! `coin` names which of the connector's coins to spend. It is an id, not a number: the connector
//! values it from its own records, and the user output, fee and change are computed here — so the
//! choice moves only which part of Omni's reserve is spent. The caller picks it because reading the
//! connector's coin set on chain is too expensive (each coin carries its source transaction).
//!
//! **The invariant.** Every path to `sign` signs a delegate built from the address (which fixes
//! `A`), the coin id, the clock, and reads of `A`'s balance and the connector — and only one that
//! does something: a withdrawal of a balance at the minimum or above, or a claim of an existing
//! `lost_found` entry. A no-op delegate would still consume `A`'s nonce and cancel the bot's pending
//! one. No admin sign, no generic `sign(payload)`, no public callback.

pub mod chain;
/// Per-chain logic, one module each; `chain::Chain` dispatches to them.
pub mod chains {
    pub mod zcash;
}
pub mod connector;
pub mod delegate;
pub mod mpc;

use std::collections::BTreeMap;

use near_sdk::json_types::{Base64VecU8, U128};
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

use chain::Chain;
use connector::{coin_key, ext_connector, ext_ft, fits, output, withdraw_msg, ConnectorConfig, Utxo};
use delegate::{signed, signing_hash, Delegate, NONCE_MULTIPLIER};
use mpc::{ext_mpc, implicit_account, parse_ed25519, Payload, SignRequest, SignatureResponse, DOMAIN_ED25519};

pub const GAS_FOR_DERIVE: Gas = Gas::from_tgas(10);
pub const GAS_FOR_BALANCE: Gas = Gas::from_tgas(5);
pub const GAS_FOR_CONFIG: Gas = Gas::from_tgas(10);
/// One coin, with its source transaction (up to ~9 KB as JSON).
pub const GAS_FOR_COIN: Gas = Gas::from_tgas(15);
/// `v1.signer` requires 15 TGas attached; the rest covers its yield callback.
pub const GAS_FOR_SIGN: Gas = Gas::from_tgas(30);
pub const GAS_FOR_ON_SIGNED: Gas = Gas::from_tgas(10);
pub const GAS_FOR_LOST_FOUND: Gas = Gas::from_tgas(5);
/// `on_lost_found`'s own work, then the sign it schedules.
pub const GAS_FOR_ON_LOST_FOUND: Gas = Gas::from_tgas(10 + 30 + 10);
/// `on_reads`' own work, then the sign it schedules.
pub const GAS_FOR_ON_READS: Gas = Gas::from_tgas(30 + 30 + 10);
/// `on_key`'s own work, the joint reads and `on_reads` — the larger of its two branches.
pub const GAS_FOR_ON_KEY: Gas = Gas::from_tgas(10 + 5 + 10 + 15 + 70);

/// Upper bound on `validity`. A signed delegate needs only the few blocks a relay takes; one that
/// lives longer can be held and relayed after the next transfer lands, splitting that balance into
/// extra withdrawals the user pays fees on.
pub const MAX_VALIDITY: u64 = 100;

/// `migrate` on the new code, in the same batch as its deploy.
pub const GAS_FOR_MIGRATE: Gas = Gas::from_tgas(50);

/// The `v1.signer` deposit, and the 1 yocto `ft_transfer_call` and `claim_lost_found` require.
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// Which delegate `on_key` builds.
#[near(serializers = [json])]
pub enum Kind {
    /// Spending this connector coin, `txid:vout`.
    Withdraw { coin: String },
    Claim,
}

/// What a signed delegate does, for its event.
#[near(serializers = [json])]
pub struct Signed {
    pub action: String,
    pub account: AccountId,
    pub address: String,
    pub amount: Option<U128>,
    pub input: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct UtxoWithdraw {
    owner: AccountId,
    /// Proposed by `transfer_ownership`, owner once it calls `accept_ownership`.
    pending_owner: Option<AccountId>,

    chain: Chain,
    /// `v1.signer` on mainnet.
    mpc_signer: AccountId,
    /// The connector's token — `zec.omft.near`.
    token: AccountId,
    /// `zcash-connector.bridge.near`.
    connector: AccountId,

    /// Blocks a signed delegate stays valid.
    validity: u64,
    /// Gas of the delegate's function call.
    withdraw_gas: Gas,
}

#[near]
impl UtxoWithdraw {
    #[init]
    pub fn new(
        owner: AccountId,
        chain: Chain,
        mpc_signer: AccountId,
        token: AccountId,
        connector: AccountId,
        validity: u64,
        withdraw_tgas: u64,
    ) -> Self {
        let this = Self {
            owner,
            pending_owner: None,
            chain,
            mpc_signer,
            token,
            connector,
            validity,
            withdraw_gas: Gas::from_tgas(withdraw_tgas),
        };
        this.assert_params();
        this
    }

    // =============== Signing ================================================================

    /// Signs `A`'s withdrawal of its whole balance to `address`, spending the connector's `coin`
    /// (`txid:vout`). Anyone may call, with 1 yocto — the signer's deposit — and at least
    /// `GAS_FOR_DERIVE + GAS_FOR_ON_KEY` free.
    #[payable]
    pub fn withdraw(&mut self, address: String, coin: String) -> Promise {
        coin_key(&coin);
        self.derive(address, Kind::Withdraw { coin })
    }

    /// Signs `A`'s `claim_lost_found` on the connector — tokens a cancelled withdrawal could not
    /// refund come back to `A`. Same terms as `withdraw`; signs only when `A` has an entry.
    #[payable]
    pub fn claim(&mut self, address: String) -> Promise {
        self.derive(address, Kind::Claim)
    }

    /// The derived key arrives; `A` is its hex. A withdrawal reads first, a claim signs at once.
    #[private]
    pub fn on_key(
        &mut self,
        address: String,
        kind: Kind,
        #[callback_result] key: Result<String, PromiseError>,
    ) -> Promise {
        let key = parse_ed25519(&key.unwrap_or_else(|_| env::panic_str("DeriveFailed")));
        let account = implicit_account(&key);
        match kind {
            Kind::Withdraw { coin } => ext_ft::ext(self.token.clone())
                .with_static_gas(GAS_FOR_BALANCE)
                .ft_balance_of(account)
                .and(ext_connector::ext(self.connector.clone()).with_static_gas(GAS_FOR_CONFIG).get_config())
                .and(
                    ext_connector::ext(self.connector.clone())
                        .with_static_gas(GAS_FOR_COIN)
                        .list_utxos(vec![coin_key(&coin)]),
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_FOR_ON_READS)
                        .on_reads(address, hex::encode(key), coin),
                ),
            Kind::Claim => ext_connector::ext(self.connector.clone())
                .with_static_gas(GAS_FOR_LOST_FOUND)
                .list_lost_found(vec![account])
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_FOR_ON_LOST_FOUND)
                        .on_lost_found(address, hex::encode(key)),
                ),
        }
    }

    /// Signs the claim only when the connector holds a `lost_found` entry for `A`.
    #[private]
    pub fn on_lost_found(
        &mut self,
        address: String,
        key: String,
        #[callback_result] entries: Result<BTreeMap<AccountId, Option<U128>>, PromiseError>,
    ) -> Promise {
        let key: [u8; 32] = parse_hex32(&key);
        let entries = entries.unwrap_or_else(|_| env::panic_str("LostFoundReadFailed"));
        let (delegate, info) = self.build_claim(&address, key, &entries);
        self.sign(&address, delegate, info)
    }

    #[private]
    pub fn on_reads(
        &mut self,
        address: String,
        key: String,
        coin: String,
        #[callback_result] balance: Result<U128, PromiseError>,
        #[callback_result] config: Result<ConnectorConfig, PromiseError>,
        #[callback_result] coins: Result<BTreeMap<String, Option<Utxo>>, PromiseError>,
    ) -> Promise {
        let key: [u8; 32] = parse_hex32(&key);
        let balance = balance.unwrap_or_else(|_| env::panic_str("BalanceReadFailed")).0;
        let config = config.unwrap_or_else(|_| env::panic_str("ConfigReadFailed"));
        let coins = coins.unwrap_or_else(|_| env::panic_str("CoinReadFailed"));
        let value = coins
            .get(&coin_key(&coin))
            .and_then(|c| c.as_ref())
            .map(|c| c.balance.0)
            .unwrap_or_else(|| env::panic_str("UnknownCoin"));
        let (delegate, info) = self.build_withdraw(&address, key, balance, &config, &coin, value);
        self.sign(&address, delegate, info)
    }

    /// Checks the signature against `A`'s key and emits the relayable `SignedDelegateAction`.
    #[private]
    pub fn on_signed(
        &mut self,
        delegate: Base64VecU8,
        hash: String,
        key: String,
        info: Signed,
        #[callback_result] response: Result<SignatureResponse, PromiseError>,
    ) -> Base64VecU8 {
        let signature = response.unwrap_or_else(|_| env::panic_str("SignFailed")).ed25519();
        let hash = parse_hex32(&hash);
        let key = parse_hex32(&key);
        require!(env::ed25519_verify(&signature, hash, &key), "InvalidSignature");

        let signed = Base64VecU8(signed(&delegate.0, &signature));
        emit("signed", json!({
            "action": info.action,
            "account": info.account,
            "address": info.address,
            "amount": info.amount,
            "input": info.input,
            "signed_delegate": signed,
        }));
        signed
    }

    // =============== Admin ==================================================================
    //
    // Every owner method takes exactly 1 yocto, so each needs a full-access key on the owner
    // account. Each logs an event.

    #[payable]
    pub fn set_params(&mut self, validity: u64, withdraw_tgas: u64) {
        self.assert_owner();
        self.validity = validity;
        self.withdraw_gas = Gas::from_tgas(withdraw_tgas);
        self.assert_params();
        emit("params_set", json!({ "validity": validity, "withdraw_tgas": withdraw_tgas }));
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

    pub fn chain(&self) -> Chain {
        self.chain
    }

    pub fn get_params(&self) -> serde_json::Value {
        json!({
            "mpc_signer": self.mpc_signer,
            "token": self.token,
            "connector": self.connector,
            "validity": self.validity,
            "withdraw_tgas": self.withdraw_gas.as_tgas(),
        })
    }

    /// The derivation path of `address` — what `v1.signer.derived_public_key` takes, with this
    /// account as `predecessor` and `domain_id` 1. Panics on an invalid address.
    pub fn path_of(&self, address: String) -> String {
        self.chain.script(&address);
        self.path(&address)
    }
}

impl UtxoWithdraw {
    fn derive(&self, address: String, kind: Kind) -> Promise {
        near_sdk::assert_one_yocto();
        let needed = GAS_FOR_DERIVE.saturating_add(GAS_FOR_ON_KEY);
        require!(env::prepaid_gas().saturating_sub(env::used_gas()) >= needed, "NotEnoughGas");
        // Validated before anything is signed: a malformed address is the one input that could
        // never be withdrawn to.
        self.chain.script(&address);
        ext_mpc::ext(self.mpc_signer.clone())
            .with_static_gas(GAS_FOR_DERIVE)
            .derived_public_key(self.path(&address), Some(env::current_account_id()), Some(DOMAIN_ED25519))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_KEY)
                    .on_key(address, kind),
            )
    }

    /// The whole transaction for a withdrawal of `balance` from `A`, spending `coin` worth `value`.
    /// Every number is computed here; the connector re-checks each and accepts only this
    /// transaction.
    pub(crate) fn build_withdraw(
        &self,
        address: &str,
        key: [u8; 32],
        balance: u128,
        config: &ConnectorConfig,
        coin: &str,
        value: u128,
    ) -> (Delegate, Signed) {
        require!(config.chain == self.chain.connector_chain(), "ConnectorChainMismatch");
        require!(balance >= config.min_withdraw_amount.0, "BelowMinimum");

        // One coin in, user output and change out: the fee never varies.
        let fee = self.chain.miner_fee(1, 2);
        let bridge_fee = config.withdraw_bridge_fee.get_fee(balance);
        let user_out = balance
            .checked_sub(bridge_fee)
            .and_then(|v| v.checked_sub(fee))
            .filter(|v| *v > 0)
            .unwrap_or_else(|| env::panic_str("BelowFees"));

        let need = user_out + fee;
        require!(fits(value, need, config.min_change_amount.0), "CoinDoesNotFit");
        let change = value - need;

        let mut outputs = vec![output(user_out, &self.chain.script(address))];
        if change > 0 {
            let change_address = config
                .change_address
                .as_deref()
                .unwrap_or_else(|| env::panic_str("NoChangeAddress"));
            outputs.push(output(change, &self.chain.script(change_address)));
        }

        let msg = withdraw_msg(address, coin, outputs, fee);
        let args = json!({ "receiver_id": self.connector, "amount": U128(balance), "msg": msg });
        let account = implicit_account(&key);
        let delegate = Delegate {
            sender_id: account.clone(),
            receiver_id: self.token.clone(),
            method_name: "ft_transfer_call",
            args: args.to_string().into_bytes(),
            gas: self.withdraw_gas,
            deposit: ONE_YOCTO,
            nonce: env::block_height() * NONCE_MULTIPLIER,
            max_block_height: env::block_height() + self.validity,
            public_key: key,
        };
        let info = Signed {
            action: "withdraw".into(),
            account,
            address: address.to_string(),
            amount: Some(U128(balance)),
            input: Some(coin.to_string()),
        };
        (delegate, info)
    }

    /// `A`'s `claim_lost_found`, if the connector holds an entry for it — else `NothingToClaim`.
    pub(crate) fn build_claim(
        &self,
        address: &str,
        key: [u8; 32],
        entries: &BTreeMap<AccountId, Option<U128>>,
    ) -> (Delegate, Signed) {
        let account = implicit_account(&key);
        let amount = entries
            .get(&account)
            .copied()
            .flatten()
            .filter(|a| a.0 > 0)
            .unwrap_or_else(|| env::panic_str("NothingToClaim"));
        let delegate = Delegate {
            sender_id: account.clone(),
            receiver_id: self.connector.clone(),
            method_name: "claim_lost_found",
            args: b"{}".to_vec(),
            gas: self.withdraw_gas,
            deposit: ONE_YOCTO,
            nonce: env::block_height() * NONCE_MULTIPLIER,
            max_block_height: env::block_height() + self.validity,
            public_key: key,
        };
        let info = Signed { action: "claim".into(), account, address: address.to_string(), amount: Some(amount), input: None };
        (delegate, info)
    }

    fn sign(&self, address: &str, delegate: Delegate, info: Signed) -> Promise {
        let bytes = delegate.encode();
        let hash = signing_hash(&bytes);
        let request = SignRequest {
            path: self.path(address),
            payload_v2: Payload::Eddsa(hex::encode(hash)),
            domain_id: DOMAIN_ED25519,
        };
        ext_mpc::ext(self.mpc_signer.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_SIGN)
            .sign(request)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_SIGNED)
                    .on_signed(Base64VecU8(bytes), hex::encode(hash), hex::encode(delegate.public_key), info),
            )
    }

    fn path(&self, address: &str) -> String {
        format!("{}{}", self.chain.path_prefix(), address)
    }

    fn assert_owner(&self) {
        near_sdk::assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "Unauthorized");
    }

    fn assert_params(&self) {
        require!(self.validity > 0 && self.validity <= MAX_VALIDITY, "InvalidValidity");
        require!(self.withdraw_gas.as_tgas() > 0 && self.withdraw_gas.as_tgas() <= 290, "InvalidWithdrawGas");
    }
}

/// NEP-297 event, standard `whm-utxo-withdraw`.
pub(crate) fn emit(event: &str, data: serde_json::Value) {
    let log = json!({ "standard": "whm-utxo-withdraw", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

fn parse_hex32(value: &str) -> [u8; 32] {
    let bytes = hex::decode(value).unwrap_or_else(|_| env::panic_str("InvalidHex"));
    bytes.try_into().unwrap_or_else(|_| env::panic_str("InvalidBytes32"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use connector::BridgeFee;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const CONTRACT: &str = "zec-withdraw.hydration-whm.near";
    const CHANGE: &str = "t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua";
    const TXID: &str = "959b9355b4157e21c927f3b1850b969ad80828125aa676b418031a25f641c099";
    const KEY: [u8; 32] = [0xab; 32];

    fn set_ctx(predecessor: &str, deposit: u128, height: u64) {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id(CONTRACT.parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_height(height)
            .prepaid_gas(Gas::from_tgas(300));
        testing_env!(ctx.build());
    }

    fn contract() -> UtxoWithdraw {
        set_ctx(accounts(0).as_str(), 1, 1_000);
        UtxoWithdraw::new(
            accounts(0),
            Chain::Zcash,
            "v1.signer".parse().unwrap(),
            "zec.omft.near".parse().unwrap(),
            "zcash-connector.bridge.near".parse().unwrap(),
            100,
            200,
        )
    }

    fn live_config() -> ConnectorConfig {
        ConnectorConfig {
            chain: "ZcashMainnet".into(),
            withdraw_bridge_fee: BridgeFee { fee_min: U128(10_000), fee_rate: 0 },
            change_address: Some(CHANGE.into()),
            min_change_amount: U128(10_000),
            min_withdraw_amount: U128(100_000),
        }
    }

    fn coin() -> String {
        format!("{TXID}:0")
    }

    /// The `Withdraw` msg inside a withdrawal delegate. Tests pay the change address itself, so both
    /// output scripts are the known one.
    fn msg_of(delegate: &Delegate) -> serde_json::Value {
        let args: serde_json::Value = serde_json::from_slice(&delegate.args).unwrap();
        serde_json::from_str(args["msg"].as_str().unwrap()).unwrap()
    }

    #[test]
    fn worked_example() {
        let c = contract();
        let (d, info) = c.build_withdraw(CHANGE, KEY, 50_000_000, &live_config(), &coin(), 7_002_606_605);

        assert_eq!(d.sender_id.as_str(), "ab".repeat(32));
        assert_eq!(d.receiver_id.as_str(), "zec.omft.near");
        assert_eq!(d.method_name, "ft_transfer_call");
        assert_eq!(d.deposit, ONE_YOCTO);
        assert_eq!(d.nonce, 1_000 * NONCE_MULTIPLIER);
        assert_eq!(d.max_block_height, 1_100);

        let args: serde_json::Value = serde_json::from_slice(&d.args).unwrap();
        assert_eq!(args["receiver_id"], "zcash-connector.bridge.near");
        assert_eq!(args["amount"], "50000000");

        let w = &msg_of(&d)["Withdraw"];
        assert_eq!(w["target_btc_address"], CHANGE);
        assert_eq!(w["input"], json!([coin()]));
        assert_eq!(w["max_gas_fee"], "10000");
        let script = "76a91413bbd8bc8df03a5a9cda88103f583aa8bc043e2488ac";
        assert_eq!(
            w["output"],
            json!([
                { "value": 49_980_000u64, "script_pubkey": script },
                { "value": 6_952_616_605u64, "script_pubkey": script },
            ])
        );
        assert_eq!(info.amount, Some(U128(50_000_000)));
        assert_eq!(info.input, Some(coin()));
    }

    #[test]
    fn exact_coin_has_no_change_output() {
        let c = contract();
        let (d, _) = c.build_withdraw(CHANGE, KEY, 1_000_000, &live_config(), &coin(), 990_000);
        let w = &msg_of(&d)["Withdraw"];
        assert_eq!(w["output"].as_array().unwrap().len(), 1);
        assert_eq!(w["output"][0]["value"], 980_000u64);
    }

    #[test]
    #[should_panic(expected = "CoinDoesNotFit")]
    fn coin_too_small() {
        contract().build_withdraw(CHANGE, KEY, 1_000_000, &live_config(), &coin(), 500_000);
    }

    #[test]
    #[should_panic(expected = "CoinDoesNotFit")]
    fn coin_would_leave_dust_change() {
        // need 990_000; 995_000 leaves 5_000 of change, under min_change_amount.
        contract().build_withdraw(CHANGE, KEY, 1_000_000, &live_config(), &coin(), 995_000);
    }

    #[test]
    #[should_panic(expected = "BelowMinimum")]
    fn below_the_connector_minimum() {
        contract().build_withdraw(CHANGE, KEY, 99_999, &live_config(), &coin(), 1 << 40);
    }

    #[test]
    #[should_panic(expected = "ConnectorChainMismatch")]
    fn wrong_connector() {
        let mut config = live_config();
        config.chain = "BitcoinMainnet".into();
        contract().build_withdraw(CHANGE, KEY, 1_000_000, &config, &coin(), 1 << 40);
    }

    #[test]
    #[should_panic(expected = "InvalidAddress")]
    fn withdraw_rejects_a_bad_address() {
        let mut c = contract();
        let _ = c.withdraw("t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ub".into(), coin());
    }

    #[test]
    #[should_panic(expected = "InvalidCoin")]
    fn withdraw_rejects_a_bad_coin_id() {
        let mut c = contract();
        let _ = c.withdraw(CHANGE.into(), format!("{TXID}@0"));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn withdraw_needs_the_signer_deposit() {
        let mut c = contract();
        set_ctx(accounts(1).as_str(), 0, 1_000);
        let _ = c.withdraw(CHANGE.into(), coin());
    }

    #[test]
    fn path_is_prefix_and_address() {
        assert_eq!(contract().path_of(CHANGE.into()), format!("zcash:v1:{CHANGE}"));
    }

    #[test]
    fn on_signed_rejects_a_foreign_signature() {
        // A signature by a key other than A's must never be emitted.
        let c = contract();
        let result = std::panic::catch_unwind(|| {
            let mut c = c;
            set_ctx(CONTRACT, 0, 1_000);
            c.on_signed(
                Base64VecU8(vec![1, 2, 3]),
                hex::encode([0u8; 32]),
                hex::encode(KEY),
                Signed { action: "withdraw".into(), account: accounts(1), address: CHANGE.into(), amount: None, input: None },
                Ok(SignatureResponse { scheme: "Ed25519".into(), signature: vec![0; 64] }),
            )
        });
        assert!(result.is_err());
    }

    #[test]
    #[should_panic(expected = "Unauthorized")]
    fn only_the_owner_sets_params() {
        let mut c = contract();
        set_ctx(accounts(1).as_str(), 1, 1_000);
        c.set_params(100, 200);
    }

    #[test]
    #[should_panic(expected = "InvalidValidity")]
    fn validity_is_capped() {
        contract().set_params(MAX_VALIDITY + 1, 200);
    }

    #[test]
    fn validity_at_the_cap() {
        let mut c = contract();
        c.set_params(MAX_VALIDITY, 200);
        assert_eq!(c.get_params()["validity"], MAX_VALIDITY);
    }

    fn lost_found(amount: Option<u128>) -> BTreeMap<AccountId, Option<U128>> {
        [(implicit_account(&KEY), amount.map(U128))].into_iter().collect()
    }

    #[test]
    fn claim_signs_an_existing_entry() {
        let (d, info) = contract().build_claim(CHANGE, KEY, &lost_found(Some(5_000)));
        assert_eq!(d.receiver_id.as_str(), "zcash-connector.bridge.near");
        assert_eq!(d.method_name, "claim_lost_found");
        assert_eq!(d.deposit, ONE_YOCTO);
        assert_eq!(info.amount, Some(U128(5_000)));
    }

    #[test]
    #[should_panic(expected = "NothingToClaim")]
    fn claim_refuses_without_an_entry() {
        contract().build_claim(CHANGE, KEY, &lost_found(None));
    }

    #[test]
    #[should_panic(expected = "NothingToClaim")]
    fn claim_refuses_a_zero_entry() {
        contract().build_claim(CHANGE, KEY, &lost_found(Some(0)));
    }

    #[test]
    #[should_panic(expected = "NothingToClaim")]
    fn claim_refuses_another_accounts_entry() {
        let other: BTreeMap<AccountId, Option<U128>> = [(implicit_account(&[0xcd; 32]), Some(U128(5_000)))].into_iter().collect();
        contract().build_claim(CHANGE, KEY, &other);
    }

    #[test]
    fn ownership_moves_on_accept() {
        let mut c = contract();
        c.transfer_ownership(accounts(1));
        set_ctx(accounts(1).as_str(), 1, 1_000);
        c.accept_ownership();
        assert_eq!(c.owner(), &accounts(1));
        assert_eq!(c.pending_owner(), None);
    }

    #[test]
    #[should_panic(expected = "Unauthorized")]
    fn only_the_owner_upgrades() {
        let mut c = contract();
        set_ctx(accounts(1).as_str(), 1, 1_000);
        let _ = c.upgrade();
    }
}
