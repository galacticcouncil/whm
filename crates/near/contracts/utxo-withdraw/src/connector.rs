//! Omni's UTXO connector (`satoshi-bridge`, deployed `0.9.7-rc.3`, commit `d2140eca`): what this
//! contract reads from it, and the `Withdraw` message it builds for it.
//!
//! The connector validates every withdrawal itself — inputs must be coins it holds, valued from its
//! own records; outputs only to the target or its change address; exactly one user output; the fee
//! within its range and under `max_gas_fee`. This contract computes every number so that the one
//! transaction the connector accepts is the one it signs.

use std::collections::BTreeMap;

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, ext_contract, near, AccountId};

/// `max(amount × fee_rate / MAX_RATIO, fee_min)` — the connector's `BridgeFee::get_fee`.
pub const MAX_RATIO: u128 = 10_000;

#[near(serializers = [json])]
pub struct BridgeFee {
    pub fee_min: U128,
    pub fee_rate: u32,
}

/// The fields of the connector's `get_config()` this contract uses; the rest are ignored.
#[near(serializers = [json])]
pub struct ConnectorConfig {
    pub chain: String,
    pub withdraw_bridge_fee: BridgeFee,
    pub change_address: Option<String>,
    pub min_change_amount: U128,
    pub min_withdraw_amount: U128,
}

/// A connector coin, as `list_utxos` returns it. Its `tx_bytes` — the source transaction, up to
/// ~9 KB — is ignored, and is why the contract reads one named coin, never a page of them.
#[near(serializers = [json])]
pub struct Utxo {
    pub balance: U128,
}

#[ext_contract(ext_connector)]
pub trait Connector {
    fn get_config(&self) -> ConnectorConfig;
    fn list_utxos(&self, utxo_storage_keys: Vec<String>) -> BTreeMap<String, Option<Utxo>>;
}

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}

impl BridgeFee {
    pub fn get_fee(&self, amount: u128) -> u128 {
        (amount * u128::from(self.fee_rate) / MAX_RATIO).max(self.fee_min.0)
    }
}

/// A coin of `value` can pay `need` alone: exactly, or with change of at least `min_change` (the
/// connector rejects smaller change).
pub fn fits(value: u128, need: u128, min_change: u128) -> bool {
    value == need || value >= need.saturating_add(min_change)
}

/// `txid:vout` — as the `Withdraw` message names a coin — to the connector's storage key,
/// `txid@vout`. Panics `InvalidCoin` on anything else.
pub fn coin_key(coin: &str) -> String {
    let (txid, vout) = coin.split_once(':').unwrap_or_else(|| env::panic_str("InvalidCoin"));
    let txid_ok = txid.len() == 64 && txid.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    let vout_ok = !vout.is_empty() && vout.len() <= 10 && vout.bytes().all(|b| b.is_ascii_digit());
    if !txid_ok || !vout_ok || vout.parse::<u32>().is_err() {
        env::panic_str("InvalidCoin");
    }
    format!("{txid}@{vout}")
}

/// One transaction output, as the connector's `TxOut` deserializes it.
pub fn output(value: u128, script: &[u8]) -> serde_json::Value {
    json!({ "value": value as u64, "script_pubkey": hex::encode(script) })
}

/// The `ft_transfer_call` msg: `TokenReceiverMessage::Withdraw`.
pub fn withdraw_msg(
    target: &str,
    input: &str,
    outputs: Vec<serde_json::Value>,
    max_gas_fee: u128,
) -> String {
    json!({
        "Withdraw": {
            "target_btc_address": target,
            "input": [input],
            "output": outputs,
            "max_gas_fee": U128(max_gas_fee),
        }
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_rules() {
        assert!(fits(1_500, 1_500, 100)); // exact, no change
        assert!(fits(1_600, 1_500, 100)); // change at the minimum
        assert!(!fits(1_550, 1_500, 100)); // dust change
        assert!(!fits(1_000, 1_500, 100)); // too small
    }

    #[test]
    fn coin_ids() {
        let txid = "959b9355b4157e21c927f3b1850b969ad80828125aa676b418031a25f641c099";
        assert_eq!(coin_key(&format!("{txid}:0")), format!("{txid}@0"));
        assert_eq!(coin_key(&format!("{txid}:12")), format!("{txid}@12"));
    }

    #[test]
    #[should_panic(expected = "InvalidCoin")]
    fn coin_id_needs_a_colon() {
        coin_key("959b9355b4157e21c927f3b1850b969ad80828125aa676b418031a25f641c099@0");
    }

    #[test]
    #[should_panic(expected = "InvalidCoin")]
    fn coin_id_needs_lowercase_hex() {
        coin_key("959B9355B4157E21C927F3B1850B969AD80828125AA676B418031A25F641C099:0");
    }

    #[test]
    #[should_panic(expected = "InvalidCoin")]
    fn coin_id_vout_is_a_u32() {
        coin_key("959b9355b4157e21c927f3b1850b969ad80828125aa676b418031a25f641c099:4294967296");
    }

    #[test]
    fn bridge_fee() {
        let flat = BridgeFee { fee_min: U128(10_000), fee_rate: 0 };
        assert_eq!(flat.get_fee(50_000_000), 10_000);
        let rated = BridgeFee { fee_min: U128(10_000), fee_rate: 20 };
        assert_eq!(rated.get_fee(50_000_000), 100_000);
    }

    #[test]
    fn config_parses_the_live_shape() {
        let live = r#"{"chain":"ZcashMainnet","btc_light_client_account_id":"zcash-client.bridge.near",
            "nbtc_account_id":"zec.omft.near","change_address":"t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua",
            "withdraw_bridge_fee":{"fee_min":"10000","fee_rate":0,"protocol_fee_rate":0},
            "min_withdraw_amount":"100000","min_change_amount":"10000","max_btc_gas_fee":"1000000"}"#;
        let config: ConnectorConfig = serde_json::from_str(live).unwrap();
        assert_eq!(config.withdraw_bridge_fee.fee_min, U128(10_000));
        assert_eq!(config.min_change_amount, U128(10_000));
    }

    #[test]
    fn coins_parse_the_live_shape() {
        let live = r#"{"959b9355b4157e21c927f3b1850b969ad80828125aa676b418031a25f641c099@0":
            {"path":"abb17a0b","tx_bytes":[4,0,0,128],"vout":0,"balance":"7002606605"},
            "0000000000000000000000000000000000000000000000000000000000000000@1":null}"#;
        let c: BTreeMap<String, Option<Utxo>> = serde_json::from_str(live).unwrap();
        let key = coin_key("959b9355b4157e21c927f3b1850b969ad80828125aa676b418031a25f641c099:0");
        assert_eq!(c[&key].as_ref().unwrap().balance, U128(7_002_606_605));
    }
}
