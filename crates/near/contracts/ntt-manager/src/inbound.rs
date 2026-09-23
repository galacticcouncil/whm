//! Inbound, peer → NEAR.
//!
//! ```text
//! complete(vaa, account_id)            checks on the unverified bytes — a panic refunds the deposit
//!   ├─ core.verify_vaa(vaa)            ┐ joint
//!   └─ token.storage_balance_of(acct)  ┘
//!        → on_verified                 re-checks on verified bytes, consumes the VAA, pays out
//!             → on_complete_settled    refunds the whole deposit if on_verified failed
//! ```
//!
//! The VAA is consumed in `on_verified` and the tokens leave in a later receipt. `pay_out` makes
//! that safe: a failed `ft_transfer` credits `claimable` against the account the VAA named.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{
    env, is_promise_success, near, require, AccountId, Gas, NearToken, Promise, PromiseError,
};

use crate::messages::{manager_message_digest, NativeTokenTransfer, NttManagerMessage, TransceiverMessage};
use crate::outbound::ext_wormhole;
use crate::payout::{ext_ft, StorageBalance, GAS_FOR_PAY_OUT_REGISTERING, GAS_FOR_REGISTER};
use crate::rate_limit::RATE_LIMIT_DURATION;
use crate::vaa::Vaa;
use crate::{account_hash, emit, now, parse_bytes32, NttManager, NttManagerExt, NEAR_CHAIN_ID};

/// What the token bridge on NEAR gives `verify_vaa`.
pub const GAS_FOR_VERIFY: Gas = Gas::from_tgas(30);
pub const GAS_FOR_STORAGE_VIEW: Gas = Gas::from_tgas(5);
pub const GAS_FOR_ON_VERIFIED: Gas = Gas::from_tgas(15);
pub const GAS_FOR_ON_SETTLED: Gas = Gas::from_tgas(5);

/// Headroom for the `executed` entry and, when queued, the queue entry — what `complete` requires
/// on top of the registration deposit. The exact cost is measured and the rest refunded.
pub const STORAGE_ALLOWANCE: NearToken = NearToken::from_millinear(5);

/// A verified transfer waiting out the inbound delay.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct InboundTransfer {
    pub account: AccountId,
    /// Untrimmed, in token units.
    pub amount: U128,
    pub source_chain: u16,
    pub queued_at: u64,
}

/// A transfer checked against config — not yet against the guardians.
struct Inbound {
    digest: [u8; 32],
    source_chain: u16,
    wormhole_sequence: u64,
    amount: u128,
}

#[near]
impl NttManager {
    /// Anyone may call. `account_id` must hash to the transfer's `to`. The deposit must cover the
    /// recipient's token registration plus `STORAGE_ALLOWANCE`; what is not used comes back.
    #[payable]
    pub fn complete(&mut self, vaa: String, account_id: AccountId) -> Promise {
        require!(!self.paused, "Paused");
        let bytes = hex::decode(&vaa).unwrap_or_else(|_| env::panic_str("InvalidVaa"));
        let inbound = self.inbound_of(&bytes, &account_id);
        require!(!self.executed.contains(&inbound.digest), "AlreadyExecuted");

        let deposit = env::attached_deposit();
        require!(
            deposit >= self.registration_deposit.saturating_add(STORAGE_ALLOWANCE),
            "InsufficientDeposit"
        );
        let callback_gas = GAS_FOR_ON_VERIFIED.saturating_add(GAS_FOR_PAY_OUT_REGISTERING);
        let needed = GAS_FOR_VERIFY
            .saturating_add(GAS_FOR_STORAGE_VIEW)
            .saturating_add(callback_gas)
            .saturating_add(GAS_FOR_ON_SETTLED);
        require!(env::prepaid_gas().saturating_sub(env::used_gas()) >= needed, "NotEnoughGas");

        let caller = env::predecessor_account_id();
        ext_wormhole::ext(self.core.clone())
            .with_static_gas(GAS_FOR_VERIFY)
            .verify_vaa(vaa.clone())
            .and(
                ext_ft::ext(self.token.clone())
                    .with_static_gas(GAS_FOR_STORAGE_VIEW)
                    .storage_balance_of(account_id.clone()),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(callback_gas)
                    .with_attached_deposit(deposit)
                    .on_verified(vaa, account_id, caller.clone()),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_SETTLED)
                    .on_complete_settled(caller, U128(deposit.as_yoctonear())),
            )
    }

    /// Consumes the VAA. Any panic here unwinds it — the VAA stays unconsumed and
    /// `on_complete_settled` returns the deposit.
    ///
    /// Returns nothing, and every promise it starts is detached: `on_complete_settled` reads this
    /// call's own outcome. Returning the pay-out would make a failure downstream of a consumed VAA
    /// — a failed registration — look like a failed `on_verified`, and the deposit would be
    /// refunded a second time.
    #[private]
    #[payable]
    pub fn on_verified(
        &mut self,
        vaa: String,
        account_id: AccountId,
        caller: AccountId,
        #[callback_result] verified: Result<u32, PromiseError>,
        #[callback_result] storage: Result<Option<StorageBalance>, PromiseError>,
    ) {
        require!(verified.is_ok(), "VaaVerifyFailed");
        let storage_before = env::storage_usage();

        let bytes = hex::decode(&vaa).unwrap_or_else(|_| env::panic_str("InvalidVaa"));
        let inbound = self.inbound_of(&bytes, &account_id);
        require!(self.executed.insert(inbound.digest), "AlreadyExecuted");

        let now = now();
        let released = self.inbound_limit(inbound.source_chain).consume(inbound.amount, now);
        if released {
            self.outbound.backflow(inbound.amount, now);
        } else {
            self.inbound_queue.insert(
                inbound.digest,
                InboundTransfer {
                    account: account_id.clone(),
                    amount: U128(inbound.amount),
                    source_chain: inbound.source_chain,
                    queued_at: now,
                },
            );
        }
        // `LookupSet` writes through; `LookupMap` caches until flushed, and storage is only
        // measurable after it.
        self.inbound_queue.flush();

        // An unreadable balance is treated as unregistered: registering twice only refunds.
        let registered = matches!(storage, Ok(Some(_)));
        let registration = if registered { None } else { Some(self.registration_deposit) };

        let storage_cost = env::storage_byte_cost()
            .saturating_mul(env::storage_usage().saturating_sub(storage_before) as u128);
        let used = storage_cost.saturating_add(registration.unwrap_or(NearToken::from_yoctonear(0)));
        let deposit = env::attached_deposit();
        require!(deposit >= used, "InsufficientDeposit");
        let excess = deposit.saturating_sub(used);
        if !excess.is_zero() {
            let _ = Promise::new(caller).transfer(excess);
        }

        let event = json!({
            "digest": hex::encode(inbound.digest),
            "account": account_id,
            "amount": U128(inbound.amount),
            "source_chain": inbound.source_chain,
            "wormhole_sequence": inbound.wormhole_sequence,
        });

        if released {
            emit("transfer_received", event);
            let _ = self.pay_out(account_id, inbound.amount, registration);
        } else {
            emit("transfer_queued_inbound", event);
            if let Some(deposit) = registration {
                let _ = ext_ft::ext(self.token.clone())
                    .with_attached_deposit(deposit)
                    .with_static_gas(GAS_FOR_REGISTER)
                    .storage_deposit(Some(account_id), Some(true));
            }
        }
    }

    /// Returns the whole deposit when `on_verified` did not complete — the token bridge's refunder.
    #[private]
    pub fn on_complete_settled(&mut self, caller: AccountId, deposit: U128) {
        if !is_promise_success() {
            let _ = Promise::new(caller).transfer(NearToken::from_yoctonear(deposit.0));
        }
    }

    /// Pays out a queued inbound transfer once its 24 h delay has passed. Anyone may call.
    pub fn release_inbound(&mut self, digest: String) -> Promise {
        require!(!self.paused, "Paused");
        let digest = parse_bytes32(&digest);
        let transfer = self
            .inbound_queue
            .remove(&digest)
            .unwrap_or_else(|| env::panic_str("TransferNotQueued"));
        require!(now() >= transfer.queued_at + RATE_LIMIT_DURATION, "TransferStillQueued");

        emit("transfer_received", json!({
            "digest": hex::encode(digest),
            "account": transfer.account,
            "amount": transfer.amount,
            "source_chain": transfer.source_chain,
        }));
        // Registered at `complete`; if that failed, the transfer fails into `claimable`.
        self.pay_out(transfer.account, transfer.amount.0, None)
    }

    pub fn get_queued_inbound(&self, digest: String) -> Option<InboundTransfer> {
        self.inbound_queue.get(&parse_bytes32(&digest)).cloned()
    }
}

impl NttManager {
    /// Parses a VAA down to its transfer and checks it against config. Guardian signatures are the
    /// core's job — this runs before `verify_vaa` to fail fast, and again after it on the same bytes.
    fn inbound_of(&self, bytes: &[u8], account_id: &AccountId) -> Inbound {
        let vaa = Vaa::parse(bytes).unwrap_or_else(|_| env::panic_str("InvalidVaa"));
        let peer = self.peer(vaa.emitter_chain);
        require!(vaa.emitter_address == peer.transceiver, "UnauthorizedEmitter");

        let tm = TransceiverMessage::parse(&vaa.payload)
            .unwrap_or_else(|_| env::panic_str("InvalidTransceiverMessage"));
        require!(tm.source_manager == peer.manager, "InvalidPeer");
        require!(
            tm.recipient_manager == account_hash(&env::current_account_id()),
            "InvalidRecipientManager"
        );

        let mm = NttManagerMessage::parse(&tm.manager_payload)
            .unwrap_or_else(|_| env::panic_str("InvalidManagerMessage"));
        let ntt = NativeTokenTransfer::parse(&mm.payload)
            .unwrap_or_else(|_| env::panic_str("InvalidTransfer"));
        require!(ntt.to_chain == NEAR_CHAIN_ID, "InvalidTargetChain");
        require!(ntt.to == account_hash(account_id), "InvalidRecipient");

        let amount = ntt.amount.untrim(self.token_decimals);
        require!(amount > 0, "ZeroAmount");

        Inbound {
            digest: manager_message_digest(vaa.emitter_chain, &tm.manager_payload),
            source_chain: vaa.emitter_chain,
            wormhole_sequence: vaa.sequence,
            amount,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::sequence_id;
    use crate::tests::{contract_with, set_ctx_with, CONTRACT, HYDRATION, MANAGER, TRANSCEIVER};
    use crate::trimmed::TrimmedAmount;

    const RECIPIENT: &str = "alice.near";
    const DEPOSIT: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR

    struct Overrides {
        emitter_chain: u16,
        emitter: [u8; 32],
        source_manager: [u8; 32],
        recipient_manager: [u8; 32],
        to_chain: u16,
        to: [u8; 32],
        amount: u64,
        id: u64,
    }

    fn defaults() -> Overrides {
        Overrides {
            emitter_chain: HYDRATION,
            emitter: parse_bytes32(TRANSCEIVER),
            source_manager: parse_bytes32(MANAGER),
            recipient_manager: env::sha256_array(CONTRACT.as_bytes()),
            to_chain: NEAR_CHAIN_ID,
            to: env::sha256_array(RECIPIENT.as_bytes()),
            amount: 400,
            id: 1,
        }
    }

    /// A VAA as Hydration would publish it — zero signatures, which only the core would reject.
    fn vaa(o: &Overrides) -> String {
        let ntt = NativeTokenTransfer {
            amount: TrimmedAmount { amount: o.amount, decimals: 8 },
            source_token: [7; 32],
            to: o.to,
            to_chain: o.to_chain,
            additional_payload: Vec::new(),
        };
        let mm = NttManagerMessage { id: sequence_id(o.id), sender: [9; 32], payload: ntt.encode().unwrap() };
        let tm = TransceiverMessage {
            source_manager: o.source_manager,
            recipient_manager: o.recipient_manager,
            manager_payload: mm.encode().unwrap(),
            transceiver_payload: Vec::new(),
        };

        let mut bytes = vec![1, 0, 0, 0, 7, 0];
        bytes.extend_from_slice(&0u32.to_be_bytes()); // timestamp
        bytes.extend_from_slice(&0u32.to_be_bytes()); // nonce
        bytes.extend_from_slice(&o.emitter_chain.to_be_bytes());
        bytes.extend_from_slice(&o.emitter);
        bytes.extend_from_slice(&42u64.to_be_bytes()); // sequence
        bytes.push(200);
        bytes.extend_from_slice(&tm.encode().unwrap());
        hex::encode(bytes)
    }

    /// ZEC-shaped: 8 dp, outbound 1_000, Hydration inbound 1_000.
    fn zec() -> NttManager {
        let mut c = contract_with(8, 1_000);
        c.set_peer(HYDRATION, MANAGER.into(), TRANSCEIVER.into(), 8, U128(1_000));
        c
    }

    fn complete(c: &mut NttManager, o: &Overrides) {
        set_ctx_with("relayer.near", 0, DEPOSIT);
        let _ = c.complete(vaa(o), RECIPIENT.parse().unwrap());
    }

    fn verified(c: &mut NttManager, o: &Overrides, registered: bool, at: u64) {
        set_ctx_with(CONTRACT, at, DEPOSIT);
        let storage = registered.then(|| StorageBalance { total: U128(1), available: U128(0) });
        c.on_verified(vaa(o), RECIPIENT.parse().unwrap(), "relayer.near".parse().unwrap(), Ok(7), Ok(storage))
    }

    fn digest(o: &Overrides) -> String {
        let bytes = hex::decode(vaa(o)).unwrap();
        let v = Vaa::parse(&bytes).unwrap();
        let tm = TransceiverMessage::parse(&v.payload).unwrap();
        hex::encode(manager_message_digest(v.emitter_chain, &tm.manager_payload))
    }

    #[test]
    fn a_valid_vaa_passes_the_precheck() {
        let mut c = zec();
        complete(&mut c, &defaults());
    }

    #[test]
    #[should_panic(expected = "UnauthorizedEmitter")]
    fn rejects_an_unknown_emitter() {
        let mut c = zec();
        complete(&mut c, &Overrides { emitter: [1; 32], ..defaults() });
    }

    #[test]
    #[should_panic(expected = "PeerNotRegistered")]
    fn rejects_an_unknown_chain() {
        let mut c = zec();
        complete(&mut c, &Overrides { emitter_chain: 2, ..defaults() });
    }

    #[test]
    #[should_panic(expected = "InvalidPeer")]
    fn rejects_a_foreign_source_manager() {
        let mut c = zec();
        complete(&mut c, &Overrides { source_manager: [1; 32], ..defaults() });
    }

    #[test]
    #[should_panic(expected = "InvalidRecipientManager")]
    fn rejects_a_message_for_another_manager() {
        let mut c = zec();
        complete(&mut c, &Overrides { recipient_manager: [1; 32], ..defaults() });
    }

    #[test]
    #[should_panic(expected = "InvalidTargetChain")]
    fn rejects_another_target_chain() {
        let mut c = zec();
        complete(&mut c, &Overrides { to_chain: 1, ..defaults() });
    }

    #[test]
    #[should_panic(expected = "InvalidRecipient")]
    fn rejects_an_account_the_vaa_does_not_name() {
        let mut c = zec();
        complete(&mut c, &Overrides { to: env::sha256_array(b"mallory.near"), ..defaults() });
    }

    #[test]
    #[should_panic(expected = "InsufficientDeposit")]
    fn requires_the_registration_deposit() {
        let mut c = zec();
        set_ctx_with("relayer.near", 0, 1);
        let _ = c.complete(vaa(&defaults()), RECIPIENT.parse().unwrap());
    }

    #[test]
    #[should_panic(expected = "VaaVerifyFailed")]
    fn a_failed_verification_consumes_nothing() {
        let mut c = zec();
        set_ctx_with(CONTRACT, 0, DEPOSIT);
        c.on_verified(
            vaa(&defaults()),
            RECIPIENT.parse().unwrap(),
            "relayer.near".parse().unwrap(),
            Err(PromiseError::Failed),
            Ok(None),
        );
    }

    #[test]
    fn verified_consumes_the_vaa_and_the_limit() {
        let mut c = zec();
        let o = defaults();
        verified(&mut c, &o, true, 0);
        assert!(c.is_executed(digest(&o)));
        assert_eq!(c.inbound_capacity(HYDRATION), Some(U128(600)));
    }

    #[test]
    fn inbound_backflows_outbound() {
        let mut c = zec();
        set_ctx_with("zec.omft.near", 0, 0);
        let msg = json!({ "recipient_chain": HYDRATION, "recipient": format!("0x{}", "11".repeat(20)) });
        let _ = c.ft_on_transfer("bob.near".parse().unwrap(), U128(300), msg.to_string());
        assert_eq!(c.outbound_capacity(), U128(700));

        verified(&mut c, &defaults(), true, 0);
        assert_eq!(c.outbound_capacity(), U128(1_000));
    }

    #[test]
    #[should_panic(expected = "AlreadyExecuted")]
    fn replay_is_refused() {
        let mut c = zec();
        let o = defaults();
        verified(&mut c, &o, true, 0);
        verified(&mut c, &o, true, 0);
    }

    #[test]
    #[should_panic(expected = "AlreadyExecuted")]
    fn replay_is_refused_before_verification_too() {
        let mut c = zec();
        let o = defaults();
        verified(&mut c, &o, true, 0);
        complete(&mut c, &o);
    }

    #[test]
    fn a_new_message_id_is_a_new_transfer() {
        let mut c = zec();
        verified(&mut c, &defaults(), true, 0);
        verified(&mut c, &Overrides { id: 2, ..defaults() }, true, 0);
        assert_eq!(c.inbound_capacity(HYDRATION), Some(U128(200)));
    }

    #[test]
    fn over_the_limit_queues_for_24h() {
        let mut c = zec();
        let o = Overrides { amount: 1_001, ..defaults() };
        verified(&mut c, &o, true, 0);
        assert!(c.is_executed(digest(&o)));
        assert_eq!(c.inbound_capacity(HYDRATION), Some(U128(1_000)));
        assert_eq!(c.get_queued_inbound(digest(&o)).unwrap().amount, U128(1_001));

        set_ctx_with("anyone.near", RATE_LIMIT_DURATION, 0);
        let _ = c.release_inbound(digest(&o));
        assert!(c.get_queued_inbound(digest(&o)).is_none());
    }

    #[test]
    #[should_panic(expected = "TransferStillQueued")]
    fn queued_inbound_waits() {
        let mut c = zec();
        let o = Overrides { amount: 1_001, ..defaults() };
        verified(&mut c, &o, true, 0);
        set_ctx_with("anyone.near", RATE_LIMIT_DURATION - 1, 0);
        let _ = c.release_inbound(digest(&o));
    }

    #[test]
    fn near_untrims_to_24_decimals() {
        let mut c = contract_with(24, u128::MAX);
        c.set_peer(HYDRATION, MANAGER.into(), TRANSCEIVER.into(), 18, U128(u128::MAX));
        let o = Overrides { amount: 150_000_000, ..defaults() };
        verified(&mut c, &o, true, 0);
        let spent = u128::MAX - c.inbound_capacity(HYDRATION).unwrap().0;
        assert_eq!(spent, 1_500_000_000_000_000_000_000_000);
    }

    #[test]
    #[should_panic(expected = "InsufficientDeposit")]
    fn an_unregistered_recipient_needs_the_registration() {
        let mut c = zec();
        set_ctx_with(CONTRACT, 0, 1_000_000_000_000_000_000_000); // 0.001 NEAR < 0.00125
        c.on_verified(
            vaa(&defaults()),
            RECIPIENT.parse().unwrap(),
            "relayer.near".parse().unwrap(),
            Ok(7),
            Ok(None),
        );
    }
}
