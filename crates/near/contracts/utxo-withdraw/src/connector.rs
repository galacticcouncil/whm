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

/// A connector coin, as `get_utxos_paged` returns it.
#[near(serializers = [json])]
pub struct Utxo {
    pub balance: U128,
}

#[ext_contract(ext_connector)]
pub trait Connector {
    fn get_config(&self) -> ConnectorConfig;
    fn get_utxos_paged(&self, from_index: Option<u64>, limit: Option<u64>) -> BTreeMap<String, Utxo>;
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

/// Best fit: the smallest coin that pays `need` exactly or leaves change of at least `min_change`.
/// Ties go to the lowest key, so the pick is deterministic. Returns the coin as the `Withdraw`
/// message names it, `txid:vout` (the connector keys coins `txid@vout`), and its value.
pub fn best_fit(coins: &BTreeMap<String, Utxo>, need: u128, min_change: u128) -> (String, u128) {
    coins
        .iter()
        .map(|(key, coin)| (key, coin.balance.0))
        .filter(|&(_, value)| value == need || value >= need.saturating_add(min_change))
        .min_by_key(|&(key, value)| (value, key.clone()))
        .map(|(key, value)| (key.replacen('@', ":", 1), value))
        .unwrap_or_else(|| env::panic_str("NoCoinFits"))
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

    fn coins(values: &[(&str, u128)]) -> BTreeMap<String, Utxo> {
        values.iter().map(|(k, v)| (k.to_string(), Utxo { balance: U128(*v) })).collect()
    }

    #[test]
    fn smallest_coin_that_covers() {
        let c = coins(&[("a@0", 9_000), ("b@1", 1_000), ("c@0", 2_000), ("d@2", 5_000)]);
        assert_eq!(best_fit(&c, 1_500, 100), ("c:0".into(), 2_000));
    }

    #[test]
    fn exact_match_needs_no_change() {
        let c = coins(&[("a@0", 1_550), ("b@0", 1_500)]);
        // 1_550 leaves dust change of 50; 1_500 is exact.
        assert_eq!(best_fit(&c, 1_500, 100), ("b:0".into(), 1_500));
    }

    #[test]
    fn dust_change_is_skipped() {
        let c = coins(&[("a@0", 1_550), ("b@0", 1_700)]);
        assert_eq!(best_fit(&c, 1_500, 100), ("b:0".into(), 1_700));
    }

    #[test]
    fn ties_go_to_the_lowest_key() {
        let c = coins(&[("b@0", 2_000), ("a@0", 2_000)]);
        assert_eq!(best_fit(&c, 1_500, 100).0, "a:0");
    }

    #[test]
    #[should_panic(expected = "NoCoinFits")]
    fn nothing_covers() {
        best_fit(&coins(&[("a@0", 1_000)]), 1_500, 100);
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
            {"path":"abb17a0b","tx_bytes":[],"vout":0,"balance":"7002606605"}}"#;
        let c: BTreeMap<String, Utxo> = serde_json::from_str(live).unwrap();
        let (input, value) = best_fit(&c, 49_990_000, 10_000);
        assert_eq!(input, "959b9355b4157e21c927f3b1850b969ad80828125aa676b418031a25f641c099:0");
        assert_eq!(value, 7_002_606_605);
    }
}
