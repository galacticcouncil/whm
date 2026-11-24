//! The chain a deployment serves, fixed at init. Each method dispatches to that chain's module in
//! `chains/`, which holds its address format, derivation path and miner fee.

use near_sdk::near;

use crate::chains::bitcoin;
use crate::chains::zcash::{self, Network};

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Chain {
    Zcash,
    ZcashTestnet,
    Bitcoin,
}

impl Chain {
    /// Prefix of every derivation path.
    pub fn path_prefix(&self) -> &'static str {
        match self {
            Chain::Zcash => Network::Mainnet.path_prefix(),
            Chain::ZcashTestnet => Network::Testnet.path_prefix(),
            Chain::Bitcoin => bitcoin::PATH_PREFIX,
        }
    }

    /// The connector's `get_config().chain` this deployment expects.
    pub fn connector_chain(&self) -> &'static str {
        match self {
            Chain::Zcash => Network::Mainnet.connector_chain(),
            Chain::ZcashTestnet => Network::Testnet.connector_chain(),
            Chain::Bitcoin => bitcoin::CONNECTOR_CHAIN,
        }
    }

    /// Output script paying `address`. Panics `InvalidAddress` on an address the chain rejects.
    pub fn script(&self, address: &str) -> Vec<u8> {
        match self {
            Chain::Zcash => zcash::script(Network::Mainnet, address),
            Chain::ZcashTestnet => zcash::script(Network::Testnet, address),
            Chain::Bitcoin => bitcoin::script(address),
        }
    }

    /// Miner fee of a withdrawal spending `inputs` coins into `outputs` outputs — no caller's choice,
    /// so none can make a user pay more. Zcash's is ZIP-317's; Bitcoin's is at `fee_rate`.
    pub fn miner_fee(&self, fee_rate: u64, inputs: usize, outputs: usize) -> u128 {
        match self {
            Chain::Zcash | Chain::ZcashTestnet => zcash::miner_fee(inputs, outputs),
            Chain::Bitcoin => bitcoin::miner_fee(fee_rate, inputs, outputs),
        }
    }

    /// The fee rate until the owner sets one, and the highest it may set, sat/vB — `None` where the
    /// chain fixes the fee itself.
    pub fn fee_rates(&self) -> Option<(u64, u64)> {
        match self {
            Chain::Zcash | Chain::ZcashTestnet => None,
            Chain::Bitcoin => Some((bitcoin::DEFAULT_FEE_RATE, bitcoin::MAX_FEE_RATE)),
        }
    }
}
