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
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault};

use inbound::InboundTransfer;
use outbound::OutboundTransfer;
use rate_limit::RateLimit;

/// Wormhole chain id of NEAR.
pub const NEAR_CHAIN_ID: u16 = 15;

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Peers,
    Inbound,
    Executed,
    Claimable,
    OutboundQueue,
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

    /// Outbound transfers over the limit, locked and waiting out the 24 h delay.
    outbound_queue: LookupMap<u64, OutboundTransfer>,

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
            outbound_queue: LookupMap::new(StorageKey::OutboundQueue),
            inbound_queue: LookupMap::new(StorageKey::InboundQueue),
        }
    }

    // =============== Admin ==================================================================

    /// Registers or replaces a peer. `manager` and `transceiver` are 32-byte hex.
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
    }

    pub fn set_outbound_limit(&mut self, limit: U128) {
        self.assert_owner();
        self.outbound.set_limit(limit.0, now());
    }

    pub fn set_inbound_limit(&mut self, chain_id: u16, limit: U128) {
        self.assert_owner();
        let now = now();
        match self.inbound.get_mut(&chain_id) {
            Some(rl) => rl.set_limit(limit.0, now),
            None => env::panic_str("PeerNotRegistered"),
        }
    }

    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
    }

    pub fn transfer_ownership(&mut self, new_owner: AccountId) {
        self.assert_owner();
        self.owner = new_owner;
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

    /// Owned by `accounts(0)`, which stays the caller.
    pub(crate) fn contract_with(token_decimals: u8, outbound_limit: u128) -> NttManager {
        set_ctx(accounts(0).as_str(), 0);
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
        set_ctx(account.as_str(), 0);
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
}
