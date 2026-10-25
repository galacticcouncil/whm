//! The contract's decisions, on the PoC's real mainnet quotes. `v1.signer`, the core and
//! `intents.near` are not called here — the builders take what they return.

use super::*;
use codec::tests::vaa_bytes;
use near_sdk::serde_json;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::testing_env;
use quote::tests::{fixture, ACCOUNT, ETH, MANAGER, ZEC};
use terms::tests::{sample, T_ADDR};

const CONTRACT: &str = "intents-router.hydration-whm.near";
const EMITTER: [u8; 32] = [0xe1; 32];
const SALT: [u8; 4] = [0xa1, 0xb2, 0xc3, 0xd4];

/// 1Click signed quote 0 at this time, quote 1 three minutes later.
const ISSUED_0: u64 = 1_792_585_081_239;
const ISSUED_1: u64 = 1_792_585_269_872;

fn set_ctx(predecessor: &str, deposit: u128, now_ms: u64) {
    let mut ctx = VMContextBuilder::new();
    ctx.current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now_ms * 1_000_000)
        .block_height(1_000)
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(ctx.build());
}

fn params() -> Params {
    Params {
        price_validity: 900,
        max_quote_age: 120,
        transfer_validity: 180,
        max_fill_multiple: 2,
        min_refund: U128(100_000_000_000_000),
    }
}

fn zec_route() -> Route {
    Route { min_withdraw: U128(100_000), min_delivery: U128(1_000_000) }
}

/// Owned by `accounts(0)`, which stays the caller, with ZEC routed.
fn contract() -> IntentRouter {
    set_ctx(accounts(0).as_str(), 1, ISSUED_0);
    let mut c = IntentRouter::new(
        accounts(0),
        "v1.signer".parse().unwrap(),
        "intents.near".parse().unwrap(),
        "contract.wormhole_crypto.near".parse().unwrap(),
        73,
        hex::encode(EMITTER),
        ETH.into(),
        vec![MANAGER.into()],
        params(),
    );
    c.set_route(ZEC.into(), zec_route());
    c
}

/// `A` of the fixtures: the PoC account is the hex of its key.
fn key() -> [u8; 32] {
    hex::decode(ACCOUNT).unwrap().try_into().unwrap()
}

fn terms_bytes(t: &Terms) -> Vec<u8> {
    t.encode().unwrap()
}

/// An order for `terms`, published `age_s` seconds before `now_ms`.
fn order_vaa(terms: &[u8], now_ms: u64, age_s: u64, amount: u128, out_per_in: u128) -> Vec<u8> {
    let order = Order { auth_path: auth_path(terms), seq: 7, amount, out_per_in };
    vaa_bytes((now_ms / 1_000 - age_s) as u32, 73, EMITTER, 99, &order.encode())
}

/// The PoC's round: 0.001 ETH, 1.8 ZEC/ETH, the order 60 s old, quote 0 30 s old.
fn poc_swap(c: &IntentRouter, t: &Terms) -> Plan {
    let terms = terms_bytes(t);
    let now = ISSUED_0 + 30_000;
    set_ctx(accounts(1).as_str(), 1, now);
    c.build_swap(&terms, &order_vaa(&terms, now, 60, 10u128.pow(15), 180_000_000), &fixture(0), key(), SALT, now)
}

fn message(plan: &Plan) -> Value {
    serde_json::from_str(&plan.message).unwrap()
}

// =============== swap ===================================================================

#[test]
fn swap_signs_the_transfer_to_the_deposit_account() {
    let c = contract();
    let t = sample();
    let plan = poc_swap(&c, &t);
    let now = ISSUED_0 + 30_000;

    assert_eq!(
        message(&plan),
        json!({
            "signer_id": ACCOUNT,
            "deadline": time::format(now + 180_000),
            "intents": [{
                "intent": "transfer",
                "receiver_id": "2e2df80005fa3b4fa32252bdb010588ed8fb65d4c6f1f74474c9cad46495bdae",
                "tokens": { ETH: "1000000000000000" },
            }],
        })
    );

    let path = auth_path(&terms_bytes(&t));
    let order_expiry = (now / 1_000 - 60 + 900) * 1_000;
    assert_eq!(plan.nonce, versioned_nonce(SALT, order_expiry, entropy(&[b"swap", &path, &7u64.to_be_bytes()])));
    assert_eq!(plan.path, path);
    assert_eq!(plan.info.seq, Some(7));
    assert_eq!(plan.info.amount, U128(10u128.pow(15)));
    assert_eq!(plan.info.min_amount_out, Some(U128(189_133)));
}

/// Two quotes for one order — the PoC's two real ones, three minutes apart — sign the same nonce:
/// whichever executes first, the other cannot.
#[test]
fn one_fill_per_order() {
    let c = contract();
    let terms = terms_bytes(&sample());
    let vaa = order_vaa(&terms, ISSUED_0, 30, 10u128.pow(15), 180_000_000);

    set_ctx(accounts(1).as_str(), 1, ISSUED_0 + 10_000);
    let first = c.build_swap(&terms, &vaa, &fixture(0), key(), SALT, ISSUED_0 + 10_000);
    set_ctx(accounts(1).as_str(), 1, ISSUED_1 + 10_000);
    let second = c.build_swap(&terms, &vaa, &fixture(1), key(), SALT, ISSUED_1 + 10_000);

    assert_ne!(message(&first)["intents"][0]["receiver_id"], message(&second)["intents"][0]["receiver_id"]);
    assert_eq!(first.nonce, second.nonce);
}

#[test]
fn the_transfer_never_outlives_the_order() {
    let c = contract();
    let terms = terms_bytes(&sample());
    let now = ISSUED_0 + 30_000;
    // Published 850 s ago: 50 s of price left, less than the 180 s transfer validity.
    let plan = c.build_swap(&terms, &order_vaa(&terms, now, 850, 10u128.pow(15), 180_000_000), &fixture(0), key(), SALT, now);
    let order_expiry = (now / 1_000 - 850 + 900) * 1_000;
    assert_eq!(message(&plan)["deadline"], time::format(order_expiry));
}

/// Builds the PoC swap with one input changed and expects `err`.
fn refused(err: &str, change: impl FnOnce(&mut IntentRouter, &mut Terms, &mut Vec<u8>, &mut [u8; 32], &mut u64)) {
    let mut c = contract();
    let mut t = sample();
    let mut key = key();
    let mut now = ISSUED_0 + 30_000;
    let terms = terms_bytes(&t);
    let mut vaa = order_vaa(&terms, now, 60, 10u128.pow(15), 180_000_000);
    change(&mut c, &mut t, &mut vaa, &mut key, &mut now);
    set_ctx(accounts(1).as_str(), 1, now);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.build_swap(&terms_bytes(&t), &vaa, &fixture(0), key, SALT, now);
    }));
    let message = result.err().map(|e| e.downcast_ref::<String>().cloned().unwrap_or_default()).unwrap_or_default();
    assert!(message.contains(err), "expected {err}, got {message:?}");
}

#[test]
fn swap_refusals() {
    // The order.
    refused("UnknownEmitter", |_, t, vaa, _, now| *vaa = vaa_bytes((*now / 1_000) as u32, 73, [1; 32], 1, &Order { auth_path: auth_path(&terms_bytes(t)), seq: 7, amount: 10u128.pow(15), out_per_in: 180_000_000 }.encode()));
    refused("UnknownEmitter", |_, t, vaa, _, now| *vaa = vaa_bytes((*now / 1_000) as u32, 2, EMITTER, 1, &Order { auth_path: auth_path(&terms_bytes(t)), seq: 7, amount: 10u128.pow(15), out_per_in: 180_000_000 }.encode()));
    refused("OrderForOtherTerms", |_, t, _, _, _| t.max_slippage_bps = 50);
    refused("OrderExpired", |_, _, vaa, _, now| *vaa = order_vaa(&terms_bytes(&sample()), *now, 900, 10u128.pow(15), 180_000_000));
    refused("OrderExpired", |_, t, vaa, _, now| {
        t.deadline = *now / 1_000;
        *vaa = order_vaa(&terms_bytes(t), *now, 60, 10u128.pow(15), 180_000_000);
    });
    refused("NotAnOrder", |_, _, vaa, _, now| *vaa = vaa_bytes((*now / 1_000) as u32, 73, EMITTER, 1, &[2; 73]));

    // The quote, against A and the clock.
    refused("WrongRecipient", |_, _, _, key, _| *key = [0xab; 32]);
    refused("QuoteTooOld", |_, _, vaa, _, now| {
        *now = ISSUED_0 + 121_000;
        *vaa = order_vaa(&terms_bytes(&sample()), *now, 60, 10u128.pow(15), 180_000_000);
    });
    refused("InvalidQuoteSignature", |c, _, _, _, _| c.quote_keys = vec![[7; 32]]);

    // Price and size.
    // 2.0 ZEC/ETH less the terms' 1% = 198000, above the quote's 189133.
    refused("BelowFloor", |_, _, vaa, _, now| *vaa = order_vaa(&terms_bytes(&sample()), *now, 60, 10u128.pow(15), 200_000_000));
    refused("BelowHardFloor", |_, t, vaa, _, now| {
        t.min_out_per_in = 190_000_000;
        *vaa = order_vaa(&terms_bytes(t), *now, 60, 10u128.pow(15), 180_000_000);
    });
    refused("AboveFillCap", |_, _, vaa, _, now| *vaa = order_vaa(&terms_bytes(&sample()), *now, 60, 4 * 10u128.pow(14), 180_000_000));

    // The terms.
    refused("UnsupportedRoute", |c, _, _, _, _| c.routes.clear());
}

#[test]
fn slippage_lowers_the_floor() {
    // 1.9 ZEC/ETH is above the quote's 189133 per 0.001 ETH: refused with no slippage, accepted
    // with the terms' 1% (188100).
    let c = contract();
    let now = ISSUED_0 + 30_000;
    let build = |slippage: u16| {
        let mut t = sample();
        t.max_slippage_bps = slippage;
        let terms = terms_bytes(&t);
        set_ctx(accounts(1).as_str(), 1, now);
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.build_swap(&terms, &order_vaa(&terms, now, 60, 10u128.pow(15), 190_000_000), &fixture(0), key(), SALT, now);
        }))
    };
    assert!(build(0).is_err());
    assert!(build(100).is_ok());
}

#[test]
#[should_panic(expected = "OrderExpired")]
fn swap_fails_fast_before_any_read() {
    let mut c = contract();
    let terms = terms_bytes(&sample());
    let now = ISSUED_0 + 30_000;
    set_ctx(accounts(1).as_str(), 1, now);
    let vaa = order_vaa(&terms, now, 1_000, 10u128.pow(15), 180_000_000);
    let _ = c.swap(Base64VecU8(terms), Base64VecU8(vaa), fixture(0));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn swap_needs_the_signer_deposit() {
    let mut c = contract();
    let terms = terms_bytes(&sample());
    let now = ISSUED_0 + 30_000;
    set_ctx(accounts(1).as_str(), 0, now);
    let vaa = order_vaa(&terms, now, 60, 10u128.pow(15), 180_000_000);
    let _ = c.swap(Base64VecU8(terms), Base64VecU8(vaa), fixture(0));
}

#[test]
#[should_panic(expected = "SameAsset")]
fn eth_to_eth_is_refused() {
    let c = contract();
    let mut t = sample();
    t.destination_asset = ETH.into();
    c.swap_terms(&terms_bytes(&t));
}

// =============== deliver and refund ======================================================

const DEADLINE_MS: u64 = 1_800_000_000_000;

fn payout(c: &IntentRouter, t: &Terms, payout: Payout, balance: u128, now_ms: u64) -> Plan {
    set_ctx(accounts(1).as_str(), 1, now_ms);
    c.build_payout(&terms_bytes(t), payout, key(), SALT, balance, now_ms, 1_000)
}

#[test]
fn deliver_withdraws_the_whole_balance_to_the_recipient() {
    let c = contract();
    let now = ISSUED_0;
    let plan = payout(&c, &sample(), Payout::Deliver, 3_817_820, now);
    assert_eq!(
        message(&plan)["intents"],
        json!([{ "intent": "ft_withdraw", "token": "zec.omft.near", "receiver_id": "zec.omft.near", "amount": "3817820", "memo": format!("WITHDRAW_TO:{T_ADDR}") }])
    );
    assert_eq!(message(&plan)["deadline"], time::format(now + 180_000));
    assert_eq!(plan.info.action, "deliver");
    assert_eq!(plan.info.receiver, T_ADDR);
}

#[test]
fn deliver_to_an_intents_account() {
    let c = contract();
    let mut t = sample();
    t.recipient_kind = RecipientKind::Intents;
    t.recipient = "alice.near".into();
    let plan = payout(&c, &t, Payout::Deliver, 2_000_000, ISSUED_0);
    assert_eq!(
        message(&plan)["intents"],
        json!([{ "intent": "transfer", "receiver_id": "alice.near", "tokens": { ZEC: "2000000" } }])
    );
}

#[test]
#[should_panic(expected = "NothingToDeliver")]
fn deliveries_batch_before_the_deadline() {
    payout(&contract(), &sample(), Payout::Deliver, 999_999, ISSUED_0);
}

#[test]
fn after_the_deadline_any_withdrawable_amount_delivers() {
    let plan = payout(&contract(), &sample(), Payout::Deliver, 100_000, DEADLINE_MS + 1);
    assert_eq!(plan.info.amount, U128(100_000));
}

#[test]
#[should_panic(expected = "NothingToDeliver")]
fn never_below_the_bridge_minimum() {
    payout(&contract(), &sample(), Payout::Deliver, 99_999, DEADLINE_MS + 1);
}

#[test]
fn refund_withdraws_eth_to_refund_to() {
    let plan = payout(&contract(), &sample(), Payout::Refund, 2 * 10u128.pow(15), DEADLINE_MS + 1);
    let to = eip55(&[0x22; 20]);
    assert_eq!(
        message(&plan)["intents"],
        json!([{ "intent": "ft_withdraw", "token": "eth.omft.near", "receiver_id": "eth.omft.near", "amount": "2000000000000000", "memo": format!("WITHDRAW_TO:{to}") }])
    );
    assert_eq!(plan.info.action, "refund");
    assert_eq!(plan.info.receiver, to);
}

#[test]
#[should_panic(expected = "BeforeDeadline")]
fn no_refund_before_the_deadline() {
    payout(&contract(), &sample(), Payout::Refund, 10u128.pow(18), DEADLINE_MS);
}

#[test]
#[should_panic(expected = "NothingToRefund")]
fn no_dust_refund() {
    payout(&contract(), &sample(), Payout::Refund, 10u128.pow(14) - 1, DEADLINE_MS + 1);
}

#[test]
fn refunds_need_no_route() {
    let mut c = contract();
    c.remove_route(ZEC.into());
    payout(&c, &sample(), Payout::Refund, 10u128.pow(15), DEADLINE_MS + 1);
}

#[test]
fn payout_nonces_differ_by_action_block_and_amount() {
    let c = contract();
    let a = payout(&c, &sample(), Payout::Deliver, 2_000_000, DEADLINE_MS + 1);
    let b = payout(&c, &sample(), Payout::Deliver, 2_000_001, DEADLINE_MS + 1);
    let r = payout(&c, &sample(), Payout::Refund, 2_000_000 * 10u128.pow(9), DEADLINE_MS + 1);
    assert_ne!(a.nonce, b.nonce);
    assert_ne!(a.nonce, r.nonce);
}

#[test]
#[should_panic(expected = "BeforeDeadline")]
fn refund_fails_fast() {
    let mut c = contract();
    set_ctx(accounts(1).as_str(), 1, DEADLINE_MS);
    let _ = c.refund(Base64VecU8(terms_bytes(&sample())));
}

// =============== signing ================================================================

#[test]
fn on_signed_rejects_a_foreign_signature() {
    let c = contract();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut c = c;
        set_ctx(CONTRACT, 0, ISSUED_0);
        c.on_signed(
            "{}".into(),
            hex::encode([0u8; 32]),
            hex::encode(key()),
            poc_swap(&contract(), &sample()).info,
            Ok(SignatureResponse { scheme: "Ed25519".into(), signature: vec![0; 64] }),
        )
    }));
    assert!(result.is_err());
}

#[test]
fn path_of_is_the_terms_hash() {
    let c = contract();
    let terms = terms_bytes(&sample());
    assert_eq!(c.path_of(Base64VecU8(terms.clone())), path_string(&env::keccak256_array(&terms)));
}

// =============== admin ==================================================================

#[test]
#[should_panic(expected = "Unauthorized")]
fn only_the_owner_sets_routes() {
    let mut c = contract();
    set_ctx(accounts(1).as_str(), 1, ISSUED_0);
    c.set_route(ZEC.into(), zec_route());
}

#[test]
fn route_rules() {
    let bad = |asset: &str, route: Route, err: &str| {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| contract().set_route(asset.into(), route)));
        let message = result.err().map(|e| e.downcast_ref::<String>().cloned().unwrap_or_default()).unwrap_or_default();
        assert!(message.contains(err), "{asset}: expected {err}, got {message:?}");
    };
    bad("zec.omft.near", zec_route(), "UnsupportedToken");
    bad(ETH, zec_route(), "SameAsset");
    bad(ZEC, Route { min_withdraw: U128(0), min_delivery: U128(1) }, "InvalidRoute");
    bad(ZEC, Route { min_withdraw: U128(2), min_delivery: U128(1) }, "InvalidRoute");
}

#[test]
fn param_bounds() {
    let bad = |p: Params, err: &str| {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| contract().set_params(p)));
        let message = result.err().map(|e| e.downcast_ref::<String>().cloned().unwrap_or_default()).unwrap_or_default();
        assert!(message.contains(err), "expected {err}, got {message:?}");
    };
    bad(Params { price_validity: 0, ..params() }, "InvalidPriceValidity");
    bad(Params { max_quote_age: MAX_QUOTE_AGE + 1, ..params() }, "InvalidQuoteAge");
    bad(Params { transfer_validity: 0, ..params() }, "InvalidTransferValidity");
    bad(Params { max_fill_multiple: 0, ..params() }, "InvalidFillMultiple");
    bad(Params { min_refund: U128(0), ..params() }, "InvalidMinRefund");
}

#[test]
#[should_panic(expected = "NoQuoteKeys")]
fn a_key_set_is_never_empty() {
    contract().set_quote_keys(vec![]);
}

#[test]
fn ownership_moves_on_accept() {
    let mut c = contract();
    c.transfer_ownership(accounts(1));
    set_ctx(accounts(1).as_str(), 1, ISSUED_0);
    c.accept_ownership();
    assert_eq!(c.owner(), &accounts(1));
    assert_eq!(c.pending_owner(), None);
}

#[test]
#[should_panic(expected = "Unauthorized")]
fn only_the_owner_upgrades() {
    let mut c = contract();
    set_ctx(accounts(1).as_str(), 1, ISSUED_0);
    let _ = c.upgrade();
}
