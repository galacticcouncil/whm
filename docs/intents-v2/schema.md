# SCHEMA — Intents v2

Companion to [spec.md](spec.md). Wire formats, interfaces and calls. The value rail's own messages —
settlement and forwarding instruction — are unchanged: [../intents/schema.md](../intents/schema.md).

---

## Message topology

```
                      HYDRATION                               ETHEREUM              NEAR
                      ─────────                               ────────              ────
  IntentDispatcher.execute (ICE callback)
    │
    ├─ IntentEmitter.placeOrder ─► [B] settlement + [C] instruction ─► IntentReceiver ─► ETH → 0xN
    │                                                                                    POA credits A
    └─ IntentQuoteEmitter.publishOrder ─► [O] order VAA ──────────────────────────────► IntentRouter
                                              emitter: IntentQuoteEmitter                 .swap(terms, O, quote)
                                              payload: (authPath, seq, amount, outPerIn)
```

[B] and [C] are the existing rail. [O] is new: one per execution, consistency 202, from a separate
emitter address — `IntentReceiver` rejects it as `UnauthorizedEmitter`, and the router accepts
nothing else. [O] and [B]/[C] share the NTT manager sequence `seq`.

---

## 1. Constants

```
Hydration Wormhole chain id  73
Hydration core bridge        0x3792a6d63c31941B2805181771795D9176fA82A1   messageFee 0
IntentQuoteEmitter           <to deploy>                     ← router pins chain 73 + this address
IntentRouter (NEAR)          intents-router.hydration-whm.near   ← MPC derivation predecessor

Wormhole core (NEAR)         contract.wormhole_crypto.near   verify_vaa: signatures + guardian set only
MPC signer (NEAR)            v1.signer                       domain_id 1 = Ed25519
Verifier                     intents.near
POA bridge RPC               https://bridge.chaindefuser.com/rpc
Solver relay RPC             https://solver-relay-v2.chaindefuser.com/rpc

ETH (intents token id)       nep141:eth.omft.near
POA min deposit (eth:1)      1e11 wei
```

---

## 2. Terms — `IIntentQuoteEmitter.Quote`, `IntentCodec` v2

One set per action. `authPath = keccak256(encodeQuote(terms))`; any change → new `A` → new `0xN`.

| Field | Type | Validation |
| --- | --- | --- |
| `quoteId` | bytes32 | random per action; non-zero |
| `maxSlippageBps` | u16 | `< 10_000` |
| `minOutPerIn` | u128 | hard floor, destination units per 1e18 wei; 0 = none |
| `minDelivery` | u128 | before the deadline, deliver only once `A` holds this much; the SDK sets it ≥ POA's `min_withdrawal_amount` for the token (`supported_tokens`), above it a batch size |
| `deadline` | u64 | unix seconds |
| `recipientKind` | u8 | 0 = withdraw off NEAR through POA; 1 = intents-account transfer |
| `refundTo` | address | Ethereum H160, non-zero |
| `destinationAsset` | string | intents ledger id (bare form, not `1cs_v1:`), 1..255 bytes of visible ASCII |
| `recipient` | string | 1..255 bytes of visible ASCII; an account id for `recipientKind 1` |

There is no on-chain asset list. Whether an asset can be bought is 1Click's: no quote, no swap — the ETH
waits in `A` and refunds after the deadline. Whether a delivery works is the terms', built by the SDK:
`recipientKind 0` only for tokens POA withdraws with a `WITHDRAW_TO:` memo, `minDelivery` from POA's
minimums. The router checks only what is structural — a withdrawal needs a `nep141:` asset (at swap and
delivery, never at parse, so terms that fail it still refund) — and never ETH → ETH.

Packed big-endian:

```
version 1 | quoteId 32 | maxSlippageBps 2 | minOutPerIn 16 | minDelivery 16 | deadline 8 | recipientKind 1
| refundTo 20 | destAssetLen 1 | destinationAsset D | recipientLen 1 | recipient R
fixed prefix 96, total 98 + D + R; wire value of version = 1
```

The version byte selects the strategy: 1 = limit swap, the only one the router accepts in the MVP. A
new strategy takes the next version, with its own layout; it hashes to a different path, so its
accounts never overlap this one's.

The encoder **and** both decoders (Solidity, Rust) enforce every check above and exact-length
accounting of both strings — a string over 255 bytes would wrap through the `uint8` length and let two
terms hash alike. The router validates raw bytes and never relies on encoder-only checks. Numeric
golden vectors pin terms, path and derived account across languages.

---

## 3. Order — `IIntentQuoteEmitter.Order`

```solidity
struct Order {
    uint64  seq;        // NTT manager sequence from placeOrder; the order's id
    uint128 amount;     // WETH this order sent (upper bound on what lands in A)
    uint128 outPerIn;   // destination smallest-units per 1e18 wei, oracle, before slippage
}

function publishOrder(Quote calldata terms, Order calldata order) external payable;   // authorized dispatchers
event OrderPublished(bytes32 indexed authPath, uint64 indexed seq, address dispatcher,
                     uint128 amount, uint128 outPerIn, uint64 wormholeSequence, bytes terms);
```

Order VAA payload:

```
msgType 1 (ORDER) | authPath 32 | seq 8 | amount 16 | outPerIn 16        total 73, consistency 202
```

- `authPath` is computed by the emitter from the terms; it binds the price to `terms.destinationAsset`.
- `amount` is informational in v1 (scan; a future `maxFillMultiple`). It is not the router's
  `amount_in` (= `balance(A)`), nor ICE's `amountIn` (the user's source asset).
- `outPerIn` uses the same unit as `minOutPerIn`:
  `mulDiv(ethUsd × 10^destFeedDec, 10^destTokenDec, destUsd × 10^ethFeedDec)`, non-zero, ≤ `uint128`.
- The VAA body timestamp (Hydration block time) is the price's age. Message identity is the VAA
  **body digest**, never the raw envelope.

---

## 4. ICE forward

```
OnResolved::Forward { contract: IntentDispatcher, data }
data = abi.encode(address depositAddress, uint256 maxRelayFee, bytes terms)     ≤ 512 bytes ⇔ D + R ≤ 286

IIntentResolutionReceiver.execute(user, intentId, assetIn, amountIn, assetOut, amountOut, data)
  → bytes4  (must return execute.selector)
```

ICE pushes `amountOut` of `assetOut` (WETH) to the dispatcher before the call, in one storage
transaction; a revert or wrong ack rolls the push back.

---

## 5. Account derivation — `(router, path) → A → 0xN`

```
MPC   derived_public_key({ predecessor: "intents-router.hydration-whm.near", path, domain_id: 1 })
        → ed25519:<bs58>
        → A = lowercase hex of the 32 decoded bytes          NEAR implicit account, no registration
POA   deposit_address({ account_id: A, chain: "eth:1" })
        → 0xN                                                only A, never the router
```

```json
POST <NEAR RPC>  query / call_function  account_id "v1.signer"  method "derived_public_key"
args { "path": "<authPath, canonical hex>", "predecessor": "intents-router.hydration-whm.near", "domain_id": 1 }

POST https://bridge.chaindefuser.com/rpc
{ "method": "deposit_address", "params": [{ "account_id": "<A>", "chain": "eth:1" }] }
→ { "result": { "address": "0xN", "chain": "eth:1" } }
```

The path string encoding (hex case, `0x` prefix) is frozen by golden vectors — a different encoding
is a different account.

---

## 6. Intent construction and signing

### The message (`nep413`)

`nonce` and `recipient` are siblings of `message`, not inside it. Every message carries one intent.

```json
{ "signer_id": "<A>", "deadline": "<RFC 3339, ms>", "intents": [ <one of the three below> ] }
```

| Action | Intent |
| --- | --- |
| **swap** | `{ "intent": "transfer", "receiver_id": "<quote.depositAddress>", "tokens": { "nep141:eth.omft.near": "<quote.amountIn>" } }` |
| **deliver**, `recipientKind 0` | `{ "intent": "ft_withdraw", "token": "<contract>", "receiver_id": "<contract>", "amount": "<balance>", "memo": "WITHDRAW_TO:<recipient>" }` |
| **deliver**, `recipientKind 1` | `{ "intent": "transfer", "receiver_id": "<recipient>", "tokens": { "<destinationAsset>": "<balance>" } }` |
| **refund** | `{ "intent": "ft_withdraw", "token": "eth.omft.near", "receiver_id": "eth.omft.near", "amount": "<balance>", "memo": "WITHDRAW_TO:<refundTo, EIP-55>" }` |

- The swap is a transfer into 1Click's deposit account, not a `token_diff`: 1Click has the solvers
  trade and pays the output back to `A` in the same transaction ([poc.md](poc.md#g1--a-counterparty)).
- `<contract>` is the ledger id without `nep141:`. Deliveries and refunds move `A`'s whole balance —
  a delivery before the deadline from `minDelivery`, after it any balance.

### What is signed

NEP-413: the Ed25519 signature is over `sha256( LE_u32(2^31 + 413) ‖ borsh({message, nonce, recipient:
"intents.near", callback_url}) )`. Do not sign the JSON directly, and do not hash twice.

```
v1.signer.sign({ request: { payload_v2: { Eddsa: "<hex of the 32-byte digest>" }, path, domain_id: 1 } })
```

1 yocto, 30 TGas attached; the router checks the returned signature against `A` before emitting it.

### Nonces and deadlines

The verifier's versioned nonce: `magic 4 ‖ version 1 ‖ salt 4 ‖ expiry_ns 8 (i64) ‖ entropy 15`;
salt from `intents.near.current_salt()`; a payload's deadline must be ≤ its nonce's expiry.

```
order expiry      = min(terms.deadline, vaa.timestamp + price_validity)            the order's price
swap      nonce   = (salt, min(terms.deadline, vaa.timestamp + MAX_PRICE_VALIDITY), H(domain ‖ "swap" ‖ path ‖ seq)[..15])
          deadline= min(now + transfer_validity, order expiry)
deliver / refund  = (salt, now + transfer_validity, H(domain ‖ action ‖ path ‖ block_height ‖ amount)[..15])
domain            = "whm-intent-router/v1",  H = sha256
```

The swap nonce depends on the order alone — not on the quote, the caller or a mutable param: every
quote for one order re-signs the same nonce, so at most one transfer per order executes. The short
deadline keeps a signed transfer from landing after its quote. One residual: the salt is the verifier's
live one, and `intents.near` keeps a rotated-out salt valid, so after a salt rotation an order can be
signed once more — a fill of what `A` still holds, sized and floored like any other (the catch-up).

### The quote — what 1Click signs

Ed25519 under 1Click's manager key, over the UTF-8 of `base58(sha256(stable JSON))` — keys sorted, no
whitespace — of a fixed field set: the request's `dry`, `swapType`, `slippageTolerance`, assets,
`depositType`, `amount`, `refundTo`/`refundType`, `recipient`/`recipientType`, `deadline` and its
optional fields when set; the quote's amounts; non-dry, its `depositAddress`, `deadline`,
`timeWhenInactive`, `timeEstimate`, fees; and `timestamp`. The bot passes exactly that set
(`signedFields` in `crates/near/scripts/intent-router/oneclick.ts`); the router reads every value it
checks from it.

| Check | Rule |
| --- | --- |
| signature | by a key in the router's set (DAO-managed) |
| shape | `dry` false, `swapType` `EXACT_INPUT`, `depositType` `INTENTS`, `amount` = `amountIn` > 0 |
| assets | `originAsset` = ETH, `destinationAsset` = the terms' |
| payee | `recipient` = `refundTo` = `A`, both `INTENTS` |
| fields | only the fields 1Click signs for a plain swap (an allowlist); `virtualChain*`, `customRecipientMsg`, `depositMemo` or any unknown field is refused |
| age | `now ≤ timestamp + max_quote_age`; the quote's `deadline` ≥ the transfer's |
| size | `amountIn` within 1% below `min(A's ETH, max_fill_multiple × order.amount)` — never the caller's choice, so a dust quote cannot spend an order |
| credited | `A's ETH ≥ order.amount × (1 − max_order_shortfall_bps)` — the order's own ETH has arrived; dust a stranger credits first does not count |
| floor | `minAmountOut × 1e18 × 10⁴ ≥ amountIn × outPerIn × (10⁴ − maxSlippageBps)`, and ≥ `amountIn × minOutPerIn / 1e18` |

### `MultiPayload` — what the bot submits

```json
{
  "standard": "nep413",
  "payload": { "recipient": "intents.near", "nonce": "<base64>", "message": "<the JSON above, escaped>" },
  "public_key": "ed25519:<bs58 of A's key>",
  "signature": "ed25519:<bs58 of the MPC signature>"
}
```

`payload.recipient` is the NEP-413 verifying contract, not the order's destination.

---

## 7. `IntentRouter` interface

`crates/near/contracts/intent-router`.

```rust
#[near(contract_state)]
pub struct IntentRouter {
    owner:          AccountId,
    pending_owner:  Option<AccountId>,
    mpc_signer:     AccountId,          // v1.signer
    intents:        AccountId,          // intents.near
    core:           AccountId,          // contract.wormhole_crypto.near
    emitter_chain:  u16,                // 73
    emitter:        [u8; 32],           // IntentQuoteEmitter
    eth_token:      String,             // nep141:eth.omft.near
    quote_keys:     Vec<[u8; 32]>,      // 1Click's quote-signing keys
    params:         Params,             // price_validity, max_quote_age, transfer_validity (s),
                                        // max_fill_multiple, max_order_shortfall_bps,
                                        // min_refund (wei, ≤ MAX_MIN_REFUND = 0.01 ETH)
}

#[near]
impl IntentRouter {
    /// The swap: a transfer of the quote's amountIn ETH from A to 1Click's deposit account.
    /// Reads A's ETH balance after deriving A; the fill must be all of it, up to the cap.
    pub fn swap(&mut self, terms: Base64VecU8, order_vaa: Base64VecU8, quote: Quote) -> Promise;
    /// A's whole destination balance to the recipient — from the terms' minDelivery before the
    /// deadline, any balance after it.
    pub fn deliver(&mut self, terms: Base64VecU8) -> Promise;
    /// After the deadline, A's whole ETH balance to refundTo.
    pub fn refund(&mut self, terms: Base64VecU8) -> Promise;
    // all three: anyone, 1 yocto (the signer's deposit), 300 TGas
    // owner: set_params, set_quote_keys, upgrade, two-step ownership
    // views: get_config, path_of(terms)
}

pub struct Quote { signed: Map<String, Value>, signature: String }   // "ed25519:<bs58>"
```

Event, so the bot needs no view on the happy path:

```json
{ "standard": "whm-intent-router", "version": "1.0.0", "event": "intent_signed",
  "data": [{ "action": "swap | deliver | refund", "account": "<A>", "auth_path": "0x…", "seq": 7,
             "token": "…", "amount": "…", "min_amount_out": "…", "receiver": "…",
             "signed_data": { "...MultiPayload..." } }] }
```

---

## 8. Bot — exact calls

**Order VAA** — from `OrderPublished` (scan) by sequence:

```
GET https://api.wormholescan.io/api/v1/vaas/73/<IntentQuoteEmitter emitter hex>/<wormholeSequence>
```

**Balances** — `intents.near.mt_batch_balance_of({ account_id: A, token_ids: [eth, destination] })`.

**Swap** — per order, once POA has credited the order's ETH to `A` (`crates/near/scripts/intent-router/swap.ts`):

```
amount = min(A's ETH, max_fill_multiple × order.amount)       the router accepts nothing else
POST 1click /v0/quote   { dry: false, swapType: EXACT_INPUT, depositType / recipientType / refundType: INTENTS,
                          originAsset: eth, destinationAsset, amount, recipient = refundTo = A, deadline }
router.swap(terms, orderVaa, { signed: signedFields(quote), signature })   1 yocto, 300 TGas
POST 1click /v0/submit-intent { type: "swap_transfer", signedData }
GET  1click /v0/status?depositAddress=…   until SUCCESS | REFUNDED | FAILED
```

`REFUNDED` returns the ETH to `A`; the next order buys it. A transfer that never executes expires
with its deadline; a new quote for the same order re-signs the same nonce.

**Deliver, refund** — `router.deliver(terms)` / `router.refund(terms)`, then on the relay
(`payout.ts`): `publish_intent({ quote_hashes: [], signed_data })` → `{ status: "OK", intent_hash }`,
and `get_status({ intent_hash })`:

| Status | Bot action |
| --- | --- |
| `PENDING`, `TX_BROADCASTED` | keep polling |
| `SETTLED` | record; reconcile balances |
| `NOT_FOUND_OR_NOT_VALID` | call again — a new block height gives a new nonce |

The bot keeps nothing whose loss strands funds: everything rebuilds from balances, router events and
verifier nonces.
