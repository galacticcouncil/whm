//! A 1Click quote, and whether the router may act on it.
//!
//! 1Click signs a fixed set of the quote's fields: Ed25519 under its manager key, over the UTF-8 of
//! `base58(sha256(stable JSON of the fields))` — keys sorted, no whitespace. The bot passes exactly
//! that set; the router re-serialises it, checks the signature, and reads every value it uses from
//! the same set. A field 1Click did not sign cannot reach a check.

use near_sdk::serde_json::{self, Map, Value};
use near_sdk::{env, near, AccountId};

use near_common::time;

/// Fields that would deliver anywhere but the intents account the quote names. Never signed for a
/// plain swap; refused if present.
const FORBIDDEN: [&str; 4] = ["virtualChainRecipient", "virtualChainRefundRecipient", "customRecipientMsg", "depositMemo"];

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Quote {
    /// The fields 1Click signed, as its `/v0/quote` response carries them — strings, integers,
    /// booleans. Fields it left out (empty, zero) are absent here too.
    pub signed: Map<String, Value>,
    /// `ed25519:<base58>`.
    pub signature: String,
}

/// What the router takes from a quote it accepts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accepted {
    /// 1Click's deposit account — the transfer's receiver.
    pub deposit: AccountId,
    pub amount_in: u128,
    /// What 1Click guarantees, else it refunds.
    pub min_amount_out: u128,
    /// When 1Click signed it, unix ms.
    pub issued_ms: u64,
    /// Until when the deposit account takes funds, unix ms.
    pub deadline_ms: u64,
}

/// What a quote must say, from the terms and the derived account.
pub struct Expect<'a> {
    pub account: &'a str,
    pub origin: &'a str,
    pub destination: &'a str,
}

/// `json-stable-stringify` of a flat object: keys sorted, no whitespace. Values must be strings,
/// unsigned integers or booleans — the only kinds 1Click signs, and the ones whose JSON is the same
/// in JavaScript and here.
pub fn stable_json(signed: &Map<String, Value>) -> Result<String, &'static str> {
    let mut keys: Vec<&String> = signed.keys().collect();
    keys.sort();
    let mut out = String::from("{");
    for (i, key) in keys.into_iter().enumerate() {
        let value = &signed[key];
        match value {
            Value::String(_) | Value::Bool(_) => {}
            Value::Number(n) if n.is_u64() => {}
            _ => return Err("UnsignableQuoteField"),
        }
        if i > 0 {
            out.push(',');
        }
        out.push_str(&serde_json::to_string(key).unwrap());
        out.push(':');
        out.push_str(&serde_json::to_string(value).unwrap());
    }
    out.push('}');
    Ok(out)
}

/// What 1Click's key signs: the UTF-8 of `base58(sha256(stable_json))`.
pub fn signing_message(signed: &Map<String, Value>) -> Result<String, &'static str> {
    Ok(bs58::encode(env::sha256_array(stable_json(signed)?.as_bytes())).into_string())
}

/// Signed by one of `keys`.
pub fn verify(quote: &Quote, keys: &[[u8; 32]]) -> Result<(), &'static str> {
    let message = signing_message(&quote.signed)?;
    let signature = parse_signature(&quote.signature)?;
    if keys.iter().any(|key| env::ed25519_verify(&signature, message.as_bytes(), key)) {
        Ok(())
    } else {
        Err("InvalidQuoteSignature")
    }
}

/// The quote's own rules: an executable exact-input swap of the origin asset into the terms'
/// asset, deposited from, paid to and refunded to `A` inside `intents.near`. The signature is
/// checked separately.
pub fn accept(signed: &Map<String, Value>, expect: &Expect) -> Result<Accepted, &'static str> {
    let text = |key: &str| signed.get(key).and_then(Value::as_str);
    let is = |key: &str, want: &str| text(key) == Some(want);
    let amount = |key: &str| text(key).and_then(|v| v.parse::<u128>().ok()).ok_or("InvalidQuoteAmount");

    if signed.get("dry") != Some(&Value::Bool(false)) {
        return Err("DryQuote");
    }
    if !is("swapType", "EXACT_INPUT") {
        return Err("NotExactInput");
    }
    if !is("depositType", "INTENTS") {
        return Err("NotAnIntentsDeposit");
    }
    if !is("originAsset", expect.origin) {
        return Err("WrongOriginAsset");
    }
    if !is("destinationAsset", expect.destination) {
        return Err("WrongDestinationAsset");
    }
    if !is("recipient", expect.account) || !is("recipientType", "INTENTS") {
        return Err("WrongRecipient");
    }
    if !is("refundTo", expect.account) || !is("refundType", "INTENTS") {
        return Err("WrongRefundTo");
    }
    if FORBIDDEN.iter().any(|key| signed.contains_key(*key)) {
        return Err("UnsupportedQuoteField");
    }

    let amount_in = amount("amountIn")?;
    if amount_in == 0 || amount("amount")? != amount_in {
        return Err("InvalidQuoteAmount");
    }
    let deposit = text("depositAddress")
        .and_then(|v| v.parse::<AccountId>().ok())
        .ok_or("InvalidDepositAddress")?;
    if deposit.as_str() == expect.account {
        return Err("InvalidDepositAddress");
    }
    Ok(Accepted {
        deposit,
        amount_in,
        min_amount_out: amount("minAmountOut")?,
        issued_ms: text("timestamp").and_then(time::parse).ok_or("InvalidQuoteTime")?,
        deadline_ms: text("deadline").and_then(time::parse).ok_or("InvalidQuoteTime")?,
    })
}

/// `"ed25519:<base58>"` → 32 key bytes.
pub fn parse_key(key: &str) -> Result<[u8; 32], &'static str> {
    decode(key)?.try_into().map_err(|_| "InvalidKey")
}

fn parse_signature(signature: &str) -> Result<[u8; 64], &'static str> {
    decode(signature)?.try_into().map_err(|_| "InvalidQuoteSignature")
}

fn decode(value: &str) -> Result<Vec<u8>, &'static str> {
    let encoded = value.strip_prefix("ed25519:").ok_or("NotEd25519")?;
    bs58::decode(encoded).into_vec().map_err(|_| "InvalidBase58")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// 1Click's manager key (one-click-sdk-typescript 0.1.26, `ONE_CLICK_MANAGER_PUB_KEY`).
    pub(crate) const MANAGER: &str = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";
    /// The PoC's test account — `recipient` and `refundTo` of both fixtures.
    pub(crate) const ACCOUNT: &str = "f1c78fbe493b9817dd9ce77a0d3959390742effc017af4be39e5563228e64ec5";
    pub(crate) const ETH: &str = "nep141:eth.omft.near";
    pub(crate) const ZEC: &str = "nep141:zec.omft.near";

    /// The two mainnet quotes of the PoC's rounds (2026-10-21), as 1Click returned them.
    const FIXTURES: &str = include_str!("../tests/fixtures/quotes.json");

    /// `buildSignedQuoteRequest` + `buildSignedQuote` of 1Click's SDK, as the bot reproduces them:
    /// a whitelist of the request, the amounts, and — non-dry — the deposit fields, plus the
    /// timestamp. Falsy values are dropped.
    pub(crate) fn signed_fields(response: &Value) -> Map<String, Value> {
        let q = &response["quoteRequest"];
        let quote = &response["quote"];
        let truthy = |v: &Value| match v {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::String(s) => !s.is_empty(),
            Value::Number(n) => n.as_f64() != Some(0.0),
            _ => true,
        };
        let mut out = Map::new();
        for key in ["dry", "swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType", "deadline"] {
            out.insert(key.into(), q[key].clone());
        }
        for key in ["quoteWaitingTimeMs", "referral", "virtualChainRecipient", "virtualChainRefundRecipient", "customRecipientMsg"] {
            if truthy(&q[key]) {
                out.insert(key.into(), q[key].clone());
            }
        }
        for key in ["amountIn", "amountInFormatted", "amountInUsd", "minAmountIn", "amountOut", "amountOutFormatted", "amountOutUsd", "minAmountOut"] {
            out.insert(key.into(), quote[key].clone());
        }
        if q["dry"] == Value::Bool(false) {
            for key in ["depositAddress", "depositMemo", "deadline", "timeWhenInactive", "timeEstimate", "refundFee", "withdrawFee"] {
                if truthy(&quote[key]) {
                    out.insert(key.into(), quote[key].clone());
                }
            }
        }
        out.insert("timestamp".into(), response["timestamp"].clone());
        out
    }

    pub(crate) fn fixture(i: usize) -> Quote {
        let all: Value = serde_json::from_str(FIXTURES).unwrap();
        let response = &all[i];
        Quote { signed: signed_fields(response), signature: response["signature"].as_str().unwrap().into() }
    }

    pub(crate) fn keys() -> Vec<[u8; 32]> {
        vec![parse_key(MANAGER).unwrap()]
    }

    fn expect() -> Expect<'static> {
        Expect { account: ACCOUNT, origin: ETH, destination: ZEC }
    }

    #[test]
    fn both_mainnet_quotes_verify() {
        for i in 0..2 {
            assert_eq!(verify(&fixture(i), &keys()), Ok(()), "quote {i}");
        }
    }

    #[test]
    fn stable_json_sorts_and_packs() {
        let mut m = Map::new();
        m.insert("b".into(), Value::from("x\"y"));
        m.insert("a".into(), Value::from(12u64));
        m.insert("c".into(), Value::Bool(false));
        assert_eq!(stable_json(&m).unwrap(), r#"{"a":12,"b":"x\"y","c":false}"#);
        m.insert("d".into(), Value::from(1.5));
        assert_eq!(stable_json(&m), Err("UnsignableQuoteField"));
    }

    #[test]
    fn any_tampering_breaks_the_signature() {
        let tamper = |key: &str, value: Value| {
            let mut q = fixture(0);
            q.signed.insert(key.into(), value);
            assert_eq!(verify(&q, &keys()), Err("InvalidQuoteSignature"), "{key}");
        };
        tamper("recipient", Value::from("attacker.near"));
        tamper("refundTo", Value::from("attacker.near"));
        tamper("depositAddress", Value::from("attacker.near"));
        tamper("minAmountOut", Value::from("1"));
        tamper("timestamp", Value::from("2026-10-21T12:18:01.240Z"));
        tamper("customRecipientMsg", Value::from("x"));

        let mut dropped = fixture(0);
        dropped.signed.remove("timeEstimate");
        assert_eq!(verify(&dropped, &keys()), Err("InvalidQuoteSignature"));
    }

    #[test]
    fn another_key_does_not_verify() {
        assert_eq!(verify(&fixture(0), &[[7; 32]]), Err("InvalidQuoteSignature"));
        // A key set verifies if any key does — a rotation without a gap.
        assert_eq!(verify(&fixture(0), &[[7; 32], keys()[0]]), Ok(()));
    }

    #[test]
    fn accepts_the_mainnet_quote() {
        let a = accept(&fixture(0).signed, &expect()).unwrap();
        assert_eq!(a.deposit.as_str(), "2e2df80005fa3b4fa32252bdb010588ed8fb65d4c6f1f74474c9cad46495bdae");
        assert_eq!(a.amount_in, 1_000_000_000_000_000);
        assert_eq!(a.min_amount_out, 189_133);
        assert_eq!(a.issued_ms, time::parse("2026-10-21T12:18:01.239Z").unwrap());
        assert_eq!(a.deadline_ms, time::parse("2026-10-24T12:28:00.467Z").unwrap());
    }

    #[test]
    fn refuses_what_does_not_pay_a() {
        let refuse = |key: &str, value: Option<Value>, err: &str| {
            let mut q = fixture(0);
            match value {
                Some(v) => q.signed.insert(key.into(), v),
                None => q.signed.remove(key),
            };
            assert_eq!(accept(&q.signed, &expect()), Err(err), "{key}");
        };
        refuse("dry", Some(Value::Bool(true)), "DryQuote");
        refuse("dry", None, "DryQuote");
        refuse("swapType", Some(Value::from("EXACT_OUTPUT")), "NotExactInput");
        refuse("depositType", Some(Value::from("ORIGIN_CHAIN")), "NotAnIntentsDeposit");
        refuse("originAsset", Some(Value::from(ZEC)), "WrongOriginAsset");
        refuse("destinationAsset", Some(Value::from(ETH)), "WrongDestinationAsset");
        refuse("recipient", Some(Value::from("attacker.near")), "WrongRecipient");
        refuse("recipientType", Some(Value::from("DESTINATION_CHAIN")), "WrongRecipient");
        refuse("refundTo", Some(Value::from("attacker.near")), "WrongRefundTo");
        refuse("refundType", Some(Value::from("ORIGIN_CHAIN")), "WrongRefundTo");
        refuse("virtualChainRecipient", Some(Value::from("0xabc")), "UnsupportedQuoteField");
        refuse("customRecipientMsg", Some(Value::from("x")), "UnsupportedQuoteField");
        refuse("depositMemo", Some(Value::from("x")), "UnsupportedQuoteField");
        refuse("amount", Some(Value::from("1")), "InvalidQuoteAmount");
        refuse("amountIn", Some(Value::from("0")), "InvalidQuoteAmount");
        refuse("minAmountOut", Some(Value::from("-1")), "InvalidQuoteAmount");
        refuse("depositAddress", None, "InvalidDepositAddress");
        refuse("depositAddress", Some(Value::from(ACCOUNT)), "InvalidDepositAddress");
        refuse("timestamp", Some(Value::from("yesterday")), "InvalidQuoteTime");
    }

    #[test]
    fn keys_parse() {
        assert_eq!(parse_key(MANAGER).unwrap().len(), 32);
        assert_eq!(parse_key("secp256k1:abc"), Err("NotEd25519"));
    }
}
