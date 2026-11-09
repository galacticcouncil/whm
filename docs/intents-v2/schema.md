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
                                              emitter: IntentQuoteEmitter                 .finalize(terms, O)
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
| `deadline` | u64 | unix seconds |
| `recipientKind` | u8 | 0 = withdraw off NEAR; 1 = intents-account transfer |
| `refundTo` | address | Ethereum H160, non-zero |
| `destinationAsset` | string | supported route ledger id (bare form, not `1cs_v1:`), 1..255 bytes UTF-8 |
| `recipient` | string | 1..255 bytes UTF-8, valid for the route |

Packed big-endian:

```
version 1 | quoteId 32 | maxSlippageBps 2 | minOutPerIn 16 | deadline 8 | recipientKind 1 | refundTo 20
| destAssetLen 1 | destinationAsset D | recipientLen 1 | recipient R
fixed prefix 80, total 82 + D + R; wire value of version = 2
```

The version byte selects the strategy: 2 = limit swap, the only one the router accepts in the MVP. A
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
data = abi.encode(address depositAddress, uint256 maxRelayFee, bytes terms)     ≤ 512 bytes ⇔ D + R ≤ 302

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

`nonce` and `recipient` are siblings of `message`, not inside it.

```json
{
  "signer_id": "<A>",
  "deadline": "<order expiry>",
  "intents": [
    { "intent": "token_diff",
      "diff": { "nep141:eth.omft.near": "-<amount_in>", "<destinationAsset>": "<amount_out>" } },
    { "intent": "ft_withdraw", "token": "<route token contract>", "receiver_id": "<route token contract>",
      "amount": "<amount_out>", "memo": "WITHDRAW_TO:<recipient>" }
  ]
}
```

- Negative = given up, positive = received; deltas are **i128**.
- `recipientKind: 1` replaces `ft_withdraw` with `transfer` to the intents account `recipient`.
- `ft_withdraw.token` is a contract account id (`zec.omft.near`), not the ledger id; POA routes take
  the token contract as receiver and the external address in the memo. Exact rules per route live in
  the router's route registry.
- **Refund:** a single `ft_withdraw` of `eth.omft.near` to `refundTo` (`WITHDRAW_TO:` memo).
  **Delivery:** a single withdrawal of the destination token to `recipient`.

### What is signed

NEP-413: the Ed25519 signature is over `sha256( LE_u32(2^31 + 413) ‖ borsh({message, nonce, recipient:
"intents.near", callback_url}) )`. Do not sign the JSON directly, and do not hash twice.

```
v1.signer.sign({ request: { payload_v2: { Eddsa: "<hex of the 32-byte digest>" }, path, domain_id: 1 } })
```

Deposit, gas and response shape are pinned against the deployed signer before release.

### Nonces

The verifier's versioned nonce: `magic 4 ‖ version 1 ‖ salt 4 ‖ expiry_ns 8 (i64) ‖ entropy 15`.

```
order expiry = min(terms.deadline, vaa.timestamp + price_validity)      payload deadline AND nonce expiry
swap         entropy = H(domain ‖ "swap"   ‖ path ‖ seq)[..15]
refund       entropy = H(domain ‖ "refund" ‖ path ‖ block_height ‖ amount)[..15]
delivery     entropy = H(domain ‖ "deliver"‖ path ‖ block_height ‖ amount)[..15]
```

A fixed expiry means re-signing an order reproduces its whole nonce, so one order fills at most once.

### `MultiPayload` — what the bot publishes

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

```rust
#[near(contract_state)]
pub struct IntentRouter {
    wormhole_core:    AccountId,      // contract.wormhole_crypto.near
    mpc_signer:       AccountId,      // v1.signer
    intents_contract: AccountId,      // intents.near
    emitter_chain:    u16,            // 73
    emitter_address:  [u8; 32],       // IntentQuoteEmitter
    price_validity:   u64,            // seconds
    eth_token:        String,         // nep141:eth.omft.near
    routes:           LookupMap<String, Route>,   // ledger id → token contract, decimals, memo rule, minimum
    owner:            AccountId,
    pending_owner:    Option<AccountId>,
}

#[near]
impl IntentRouter {
    /// Swap, deliver or refund for the account the terms derive. Permissionless.
    pub fn finalize(&mut self, terms: Base64VecU8, order_vaa: Base64VecU8) -> Promise;
    // private callbacks only; owner: routes, price_validity, upgrade, two-step ownership
}
```

Event, so the bot needs no view on the happy path:

```json
{ "standard": "intent_router", "version": "1.0.0", "event": "intent_signed",
  "data": [{ "auth_path": "0x…", "action": "swap | refund | deliver", "seq": 7,
             "account": "<A>", "amount_in": "…", "amount_out": "…",
             "recipient": "…", "signed_data": { "...MultiPayload..." } }] }
```

---

## 8. Bot — exact calls

**Order VAA** — from `OrderPublished` (scan) by sequence:

```
GET https://api.wormholescan.io/api/v1/vaas/73/<IntentQuoteEmitter emitter hex>/<wormholeSequence>
```

**Balances** — `intents.near.mt_batch_balance_of({ account_id: A, token_ids: [eth, destination] })`.

**Publish** — `publish_intent({ quote_hashes: [], signed_data })` → `{ status: "OK", intent_hash }`.

**Status** — `get_status({ intent_hash })`:

| Status | Bot action |
| --- | --- |
| `PENDING`, `TX_BROADCASTED` | keep polling |
| `SETTLED` | record; reconcile balances |
| `NOT_FOUND_OR_NOT_VALID` | nonce unused and VAA valid → re-sign; else wait for the next order or the deadline |

The bot keeps nothing whose loss strands funds: everything rebuilds from balances, router events and
verifier nonces.
