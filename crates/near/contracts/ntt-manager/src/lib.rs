//! NEAR NTT — NttManager and Wormhole transceiver in one contract, LOCKING, one deployment per
//! token. Design: `docs/near-ntt/spec.md`.
//!
//! Every address on the wire is `bytes32`; a NEAR account is its `sha256(account_id)`, the digest
//! the Wormhole core on NEAR already uses for emitters.

pub mod messages;
pub mod rate_limit;
pub mod trimmed;
pub mod vaa;

use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault, PromiseOrValue};

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

    /// `contract.wormhole_crypto.near` on mainnet.
    core: AccountId,

    /// Next outbound `NttManagerMessage.id`.
    seq: u64,

    peers: LookupMap<u16, Peer>,
    outbound: RateLimit,
    inbound: LookupMap<u16, RateLimit>,

    /// NTT digests already executed — the replay key, not the VAA hash.
    executed: LookupSet<[u8; 32]>,

    /// Inbound unlocks whose `ft_transfer` failed after the VAA was consumed.
    claimable: LookupMap<AccountId, u128>,
}

#[near]
impl NttManager {
    #[init]
    pub fn new(
        owner: AccountId,
        token: AccountId,
        token_decimals: u8,
        core: AccountId,
        outbound_limit: U128,
    ) -> Self {
        Self {
            owner,
            paused: false,
            token,
            token_decimals,
            core,
            seq: 0,
            peers: LookupMap::new(StorageKey::Peers),
            outbound: RateLimit::new(outbound_limit.0, now()),
            inbound: LookupMap::new(StorageKey::Inbound),
            executed: LookupSet::new(StorageKey::Executed),
            claimable: LookupMap::new(StorageKey::Claimable),
        }
    }

    // =============== Transfers ==============================================================

    /// Outbound, NEAR → peer. Called by `config.token` through `ft_transfer_call`, with
    /// `msg = {"recipient_chain", "recipient", "should_queue"}`. Returns the unused amount, which the
    /// token refunds: the trim dust always, the whole amount on a refused or failed send.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let _ = (sender_id, amount, msg);
        env::panic_str("Unimplemented: outbound, see docs/near-ntt/spec.md#outbound--near--hydration")
    }

    /// Inbound, peer → NEAR. Anyone may call; `account_id` must hash to the transfer's `to`. The
    /// attached deposit covers the recipient's token storage and the replay entry; the rest is
    /// refunded.
    #[payable]
    pub fn complete(&mut self, vaa: String, account_id: AccountId) {
        let _ = (vaa, account_id);
        env::panic_str("Unimplemented: inbound, see docs/near-ntt/spec.md#inbound--hydration--near")
    }

    /// Pays out an inbound unlock that failed after its VAA was consumed.
    pub fn claim(&mut self) {
        env::panic_str("Unimplemented: claim, see docs/near-ntt/spec.md#inbound--hydration--near")
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
}

/// A NEAR account on the wire.
pub fn account_hash(account_id: &AccountId) -> [u8; 32] {
    env::sha256_array(account_id.as_bytes())
}

/// Block time, seconds.
fn now() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn parse_bytes32(value: &str) -> [u8; 32] {
    let bytes = hex::decode(value.trim_start_matches("0x"))
        .unwrap_or_else(|_| env::panic_str("InvalidHex"));
    bytes.try_into().unwrap_or_else(|_| env::panic_str("InvalidBytes32"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const HYDRATION: u16 = 73;
    const MANAGER: &str = "0x000000000000000000000000FCaF4aA069C565d25539028970703F01e47D3E0B";
    const TRANSCEIVER: &str = "0x0000000000000000000000004e7b1e55d2354d4dc6abd876096dc201de0541d1";

    fn contract() -> NttManager {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id("ntt-zec.whm.near".parse().unwrap())
            .predecessor_account_id(accounts(0));
        testing_env!(ctx.build());
        NttManager::new(accounts(0), "zec.omft.near".parse().unwrap(), 8, "contract.wormhole_crypto.near".parse().unwrap(), U128(1_000))
    }

    fn as_caller(account: AccountId) {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id("ntt-zec.whm.near".parse().unwrap())
            .predecessor_account_id(account);
        testing_env!(ctx.build());
    }

    #[test]
    fn emitter_is_sha256_of_the_account() {
        let c = contract();
        assert_eq!(c.emitter(), hex::encode(env::sha256(b"ntt-zec.whm.near")));
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
