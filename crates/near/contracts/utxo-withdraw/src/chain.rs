//! The chain a deployment serves, fixed at init. Each method dispatches to that chain's module in
//! `chains/`, which holds its address format, derivation path and miner fee.

use near_sdk::near;

use crate::chains::zcash;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Chain {
    Zcash,
}

impl Chain {
    /// Prefix of every derivation path.
    pub fn path_prefix(&self) -> &'static str {
        match self {
            Chain::Zcash => zcash::PATH_PREFIX,
        }
    }

    /// The connector's `get_config().chain` this deployment expects.
    pub fn connector_chain(&self) -> &'static str {
        match self {
            Chain::Zcash => zcash::CONNECTOR_CHAIN,
        }
    }

    /// Output script paying `address`. Panics `InvalidAddress` on an address the chain rejects.
    pub fn script(&self, address: &str) -> Vec<u8> {
        match self {
            Chain::Zcash => zcash::script(address),
        }
    }

    /// Miner fee of a withdrawal spending `inputs` coins into `outputs` outputs.
    pub fn miner_fee(&self, inputs: usize, outputs: usize) -> u128 {
        match self {
            Chain::Zcash => zcash::miner_fee(inputs, outputs),
        }
    }
}
