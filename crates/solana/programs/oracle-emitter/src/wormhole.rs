use anchor_lang::prelude::*;

pub const CORE_BRIDGE_PROGRAM_ID: Pubkey = pubkey!("worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth");
pub const CORE_BRIDGE_CONFIG: Pubkey = pubkey!("2yVjuQwpsvdsrywzsJJVs9Ueh4zayyo5DYJbBNc3DDpn");
pub const CORE_BRIDGE_FEE_COLLECTOR: Pubkey = pubkey!("9bFNrXNb2WTx8fMHXCheaZqkLZ3YCCaiqTftHxeintHy");

#[derive(Debug, Default, AnchorSerialize, AnchorDeserialize, Clone)]
pub struct BridgeData {
    pub guardian_set_index: u32,
    pub last_lamports: u64,
    pub config: BridgeConfig,
}

impl BridgeData {
    pub fn fee(&self) -> u64 {
        self.config.fee
    }
}

#[derive(Debug, Default, AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub struct BridgeConfig {
    pub guardian_set_expiration_time: u32,
    pub fee: u64,
}
