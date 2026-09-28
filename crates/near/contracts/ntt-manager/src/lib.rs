//! NEAR NTT — NttManager and Wormhole transceiver in one contract, LOCKING, one deployment per
//! token. Design: `docs/near-ntt/spec.md`.
//!
//! Every address on the wire is `bytes32`; a NEAR account is its `sha256(account_id)`, the digest
//! the Wormhole core on NEAR already uses for emitters.

pub mod inbound;
pub mod messages;
pub mod outbound;
pub mod payout;
pub mod rate_limit;
pub mod trimmed;
pub mod vaa;

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise};

use inbound::InboundTransfer;
use rate_limit::RateLimit;

/// Wormhole chain id of NEAR.
pub const NEAR_CHAIN_ID: u16 = 15;

/// `migrate` on the new code, in the same batch as its deploy.
pub const GAS_FOR_MIGRATE: Gas = Gas::from_tgas(50);

/// Append-only: a redeploy that reorders or removes a variant points collections at the wrong
/// prefix. Any change to a stored layout needs an `#[init(ignore_state)]` migration with it.
#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Peers,
    Inbound,
    Executed,
    Claimable,
    InboundQueue,
}

/// A remote NTT deployment: its manager, its Wormhole emitter, and the precision it trims to.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Peer {
    pub manager: [u8; 32],
    pub transceiver: [u8; 32],
    pub decimals: u8,
}

#[near(serializers = [json])]
pub struct PeerView {
    pub manager: String,
    pub transceiver: String,
    pub decimals: u8,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct NttManager {
    owner: AccountId,
    paused: bool,

    /// The NEP-141 this contract locks.
    token: AccountId,
    token_decimals: u8,

    /// The token's NEP-145 registration, `storage_balance_bounds().min` — paid from the `complete`
    /// deposit for a first-time recipient.
    registration_deposit: NearToken,

    /// `contract.wormhole_crypto.near` on mainnet.
    core: AccountId,

    /// Next outbound `NttManagerMessage.id`.
    seq: u64,

    peers: LookupMap<u16, Peer>,
    outbound: RateLimit,
    inbound: LookupMap<u16, RateLimit>,

    /// NTT digests already executed — the replay key, not the VAA hash.
    executed: LookupSet<[u8; 32]>,

    /// Pay-outs whose `ft_transfer` failed — inbound unlocks and refunds alike.
    claimable: LookupMap<AccountId, u128>,

    /// Inbound transfers over the limit, verified and consumed, waiting out the 24 h delay.
    inbound_queue: LookupMap<[u8; 32], InboundTransfer>,
}

#[near]
impl NttManager {
    #[init]
    pub fn new(
        owner: AccountId,
        token: AccountId,
        token_decimals: u8,
        registration_deposit: U128,
        core: AccountId,
        outbound_limit: U128,
    ) -> Self {
        Self {
            owner,
            paused: false,
            token,
            token_decimals,
            registration_deposit: NearToken::from_yoctonear(registration_deposit.0),
            core,
            seq: 0,
            peers: LookupMap::new(StorageKey::Peers),
            outbound: RateLimit::new(outbound_limit.0, now()),
            inbound: LookupMap::new(StorageKey::Inbound),
            executed: LookupSet::new(StorageKey::Executed),
            claimable: LookupMap::new(StorageKey::Claimable),
            inbound_queue: LookupMap::new(StorageKey::InboundQueue),
        }
    }

    // =============== Admin ==================================================================
    //
    // Every owner method takes exactly 1 yocto: a function-call access key cannot attach a deposit,
    // so each one needs a full-access key on the owner account. Each logs a `whm-ntt` event.

    /// Registers or replaces a peer. `manager` and `transceiver` are 32-byte hex.
    ///
    /// Replacing one strands VAAs still in flight from the old pair until it is set again — they
    /// never expire, and the replay key does not depend on the peer. Drain before rotating.
    #[payable]
    pub fn set_peer(
        &mut self,
        chain_id: u16,
        manager: String,
        transceiver: String,
        decimals: u8,
        inbound_limit: U128,
    ) {
        self.assert_owner();
        require!(chain_id != 0 && chain_id != NEAR_CHAIN_ID, "InvalidPeerChainId");
        require!(decimals != 0, "InvalidPeerDecimals");

        let manager = parse_bytes32(&manager);
        let transceiver = parse_bytes32(&transceiver);
        require!(manager != [0u8; 32] && transceiver != [0u8; 32], "InvalidPeerZeroAddress");

        self.peers.insert(chain_id, Peer { manager, transceiver, decimals });
        let now = now();
        match self.inbound.get_mut(&chain_id) {
            Some(limit) => limit.set_limit(inbound_limit.0, now),
            None => {
                self.inbound.insert(chain_id, RateLimit::new(inbound_limit.0, now));
            }
        }
        emit("peer_set", json!({
            "chain_id": chain_id,
            "manager": hex::encode(manager),
            "transceiver": hex::encode(transceiver),
            "decimals": decimals,
            "inbound_limit": inbound_limit,
        }));
    }

    #[payable]
    pub fn set_outbound_limit(&mut self, limit: U128) {
        self.assert_owner();
        self.outbound.set_limit(limit.0, now());
        emit("outbound_limit_set", json!({ "limit": limit }));
    }

    #[payable]
    pub fn set_inbound_limit(&mut self, chain_id: u16, limit: U128) {
        self.assert_owner();
        let now = now();
        match self.inbound.get_mut(&chain_id) {
            Some(rl) => rl.set_limit(limit.0, now),
            None => env::panic_str("PeerNotRegistered"),
        }
        emit("inbound_limit_set", json!({ "chain_id": chain_id, "limit": limit }));
    }

    #[payable]
    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        emit("paused", json!({}));
    }

    #[payable]
    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
        emit("unpaused", json!({}));
    }

    #[payable]
    pub fn transfer_ownership(&mut self, new_owner: AccountId) {
        self.assert_owner();
        emit("ownership_transferred", json!({ "previous_owner": self.owner, "new_owner": new_owner }));
        self.owner = new_owner;
    }

    /// Redeploys this contract with the wasm passed as the call's raw input (not JSON), then runs
    /// the new code's `migrate` — one batch on this account, so a `migrate` that fails reverts the
    /// deploy too and the old code stays.
    ///
    /// The upgrade authority is `owner`, not an access key: once the account's keys are deleted
    /// (migration step 006), only the owner can change the code — the NEAR form of EVM NTT's
    /// owner-gated UUPS upgrade.
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

    /// Run by `upgrade` on the new code. Reads the state as it is; a release that changes a stored
    /// layout replaces this body with the conversion. Every release keeps the method.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        env::state_read().unwrap_or_else(|| env::panic_str("NoState"))
    }

    // =============== Views ==================================================================

    pub fn owner(&self) -> &AccountId {
        &self.owner
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn token(&self) -> &AccountId {
        &self.token
    }

    /// This contract's Wormhole emitter — `sha256(account_id)`, hex. The peer address Hydration
    /// registers for both the manager and the transceiver.
    pub fn emitter(&self) -> String {
        hex::encode(account_hash(&env::current_account_id()))
    }

    pub fn get_peer(&self, chain_id: u16) -> Option<PeerView> {
        self.peers.get(&chain_id).map(|p| PeerView {
            manager: hex::encode(p.manager),
            transceiver: hex::encode(p.transceiver),
            decimals: p.decimals,
        })
    }

    pub fn outbound_capacity(&self) -> U128 {
        U128(self.outbound.capacity(now()))
    }

    pub fn inbound_capacity(&self, chain_id: u16) -> Option<U128> {
        self.inbound.get(&chain_id).map(|rl| U128(rl.capacity(now())))
    }

    pub fn is_executed(&self, digest: String) -> bool {
        self.executed.contains(&parse_bytes32(&digest))
    }

    pub fn claimable_of(&self, account_id: AccountId) -> U128 {
        U128(self.claimable.get(&account_id).copied().unwrap_or(0))
    }
}

impl NttManager {
    fn assert_owner(&self) {
        near_sdk::assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "Unauthorized");
    }

    pub(crate) fn peer(&self, chain_id: u16) -> Peer {
        self.peers
            .get(&chain_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("PeerNotRegistered"))
    }

    /// Every peer has an inbound limit — `set_peer` creates both together.
    pub(crate) fn inbound_limit(&mut self, chain_id: u16) -> &mut RateLimit {
        self.inbound
            .get_mut(&chain_id)
            .unwrap_or_else(|| env::panic_str("PeerNotRegistered"))
    }
}

/// A NEAR account on the wire.
pub fn account_hash(account_id: &AccountId) -> [u8; 32] {
    env::sha256_array(account_id.as_bytes())
}

/// NEP-297 event, standard `whm-ntt`.
pub(crate) fn emit(event: &str, data: serde_json::Value) {
    let log = json!({ "standard": "whm-ntt", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{log}"));
}

/// Block time, seconds.
pub(crate) fn now() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

pub(crate) fn parse_bytes32(value: &str) -> [u8; 32] {
    let bytes = hex::decode(value.trim_start_matches("0x"))
        .unwrap_or_else(|_| env::panic_str("InvalidHex"));
    bytes.try_into().unwrap_or_else(|_| env::panic_str("InvalidBytes32"))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, Gas};

    pub(crate) const CONTRACT: &str = "ntt-zec.whm.near";
    pub(crate) const TOKEN: &str = "zec.omft.near";
    pub(crate) const HYDRATION: u16 = 73;
    pub(crate) const MANAGER: &str =
        "0x000000000000000000000000FCaF4aA069C565d25539028970703F01e47D3E0B";
    pub(crate) const TRANSCEIVER: &str =
        "0x0000000000000000000000004e7b1e55d2354d4dc6abd876096dc201de0541d1";

    /// ZEC and wNEAR both: `storage_balance_bounds().min`.
    pub(crate) const REGISTRATION: u128 = 1_250_000_000_000_000_000_000;

    /// Calls as `predecessor` at `at` seconds, with a full 300 TGas.
    pub(crate) fn set_ctx(predecessor: &str, at: u64) {
        set_ctx_with(predecessor, at, 0);
    }

    /// `set_ctx`, attaching `deposit` yocto.
    pub(crate) fn set_ctx_with(predecessor: &str, at: u64, deposit: u128) {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id(CONTRACT.parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap())
            .block_timestamp(at * 1_000_000_000)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .prepaid_gas(Gas::from_tgas(300));
        testing_env!(ctx.build());
    }

    /// Owned by `accounts(0)`, which stays the caller — with the 1 yocto owner methods take.
    pub(crate) fn contract_with(token_decimals: u8, outbound_limit: u128) -> NttManager {
        set_ctx_with(accounts(0).as_str(), 0, 1);
        NttManager::new(
            accounts(0),
            TOKEN.parse().unwrap(),
            token_decimals,
            U128(REGISTRATION),
            "contract.wormhole_crypto.near".parse().unwrap(),
            U128(outbound_limit),
        )
    }

    fn contract() -> NttManager {
        contract_with(8, 1_000)
    }

    fn as_caller(account: AccountId) {
        set_ctx_with(account.as_str(), 0, 1);
    }

    #[test]
    fn emitter_is_sha256_of_the_account() {
        let c = contract();
        assert_eq!(c.emitter(), hex::encode(env::sha256(CONTRACT.as_bytes())));
    }

    #[test]
    fn owner_registers_a_peer() {
        let mut c = contract();
        c.set_peer(HYDRATION, MANAGER.into(), TRANSCEIVER.into(), 8, U128(500));

        let peer = c.get_peer(HYDRATION).unwrap();
        assert_eq!(peer.manager, MANAGER.trim_start_matches("0x").to_lowercase());
        assert_eq!(peer.decimals, 8);
        assert_eq!(c.inbound_capacity(HYDRATION), Some(U128(500)));
        assert_eq!(c.outbound_capacity(), U128(1_000));
    }

    #[test]
    #[should_panic(expected = "Unauthorized")]
    fn only_owner_registers_peers() {
        let mut c = contract();
        as_caller(accounts(1));
        c.set_peer(HYDRATION, MANAGER.into(), TRANSCEIVER.into(), 8, U128(500));
    }

    #[test]
    #[should_panic(expected = "InvalidPeerChainId")]
    fn near_cannot_peer_itself() {
        let mut c = contract();
        c.set_peer(NEAR_CHAIN_ID, MANAGER.into(), TRANSCEIVER.into(), 8, U128(500));
    }

    #[test]
    fn re_registering_moves_the_inbound_limit() {
        let mut c = contract();
        c.set_peer(HYDRATION, MANAGER.into(), TRANSCEIVER.into(), 8, U128(500));
        c.set_peer(HYDRATION, MANAGER.into(), TRANSCEIVER.into(), 8, U128(800));
        assert_eq!(c.inbound_capacity(HYDRATION), Some(U128(800)));
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn owner_methods_need_a_full_access_key() {
        let mut c = contract();
        set_ctx(accounts(0).as_str(), 0);
        c.transfer_ownership(accounts(1));
    }

    #[test]
    #[should_panic(expected = "Paused")]
    fn claims_wait_out_a_pause() {
        let mut c = contract();
        c.pause();
        as_caller(accounts(1));
        let _ = c.claim();
    }

    #[test]
    #[should_panic(expected = "Unauthorized")]
    fn only_the_owner_upgrades() {
        let mut c = contract();
        as_caller(accounts(1));
        let _ = c.upgrade();
    }
}
