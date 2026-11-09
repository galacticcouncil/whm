# PLAN — Intents v2 MVP

Status: **proposal, nothing implemented.** Branch `feat/intent-v2`. Design: [spec.md](spec.md).
Review findings and their resolutions: [Appendix A](#appendix-a--review-disposition).

**Goal.** Replace 1Click with our own implementation: one **reusable deposit address per action**
(a swap, or a whole DCA), priced **on-chain** on Hydration, executed unattended. Everything else —
the WETH → Ethereum → POA rail, NEAR Intents, MPC — is reused as is.

---

## 1. Decisions

| #   | Decision |
| --- | -------- |
| D1  | Value rail unchanged: Hydration WETH → NTT → `IntentReceiver` → native ETH to POA's `0xN` → credited to NEAR account `A`. |
| D2  | 1Click is dropped; swaps and DCA use this flow. |
| D3  | Triggered by ICE `OnResolved::Forward` → `IntentDispatcher.execute`, or directly via `IntentDispatcher.dispatch`. |
| D4  | **One action = one set of terms = one `A` = one `0xN`.** Terms travel inside every order; there is no separate terms publication. |
| D5  | **Price bound to the order:** each tranche publishes one order VAA `(authPath, seq, amount, outPerIn)`. |
| D6  | `IntentQuoteEmitter` is a thin, stable publisher (NEAR pins its address); `IntentDispatcher` holds all logic (ICE stores its address). Both UUPS. |
| D7  | NEAR `IntentRouter` is stateless (config only), DAO-upgradeable like the near-ntt manager, at `intents-router.hydration-whm.near`. |
| D8  | **`finalize(terms, orderVaa)` — two arguments.** |
| D9  | Refund **only after the deadline**; below the hard floor funds hold. |
| D10 | **Full catch-up:** each fill spends `balance(A)`; one fill per order. |
| D11 | No price refresh: feeds pushed hourly + on a 0.1% move; the dispatcher refuses a feed older than `maxFeedAge`. |
| D12 | v1 is floor-only: one limit order at `outPerIn × (1 − maxSlippageBps)`. |
| D13 | The bot is NEAR-only and untrusted (gas key only). |

---

## 2. Architecture

```
                 ICE intent (on_resolved)            user / integrator (direct)
                          │                                    │
                          ▼                                    ▼
             ┌────────────────────────────────────────────────────────────┐
             │ IntentDispatcher      (UUPS proxy — the address ICE stores)  │
             │   execute(…)    ICE callback                                 │
             │   dispatch(…)   direct path                                  │
             │   reads price feeds (routes, heartbeat check) → outPerIn     │
             └──────────────┬───────────────────────────────┬─────────────┘
                            │                               │
                   placeOrder(…) → seq          publishOrder(terms, order)
                            │                               │  (authorized dispatchers only)
                            ▼                               ▼
             ┌───────────────────────────┐   ┌───────────────────────────────────────────┐
             │ IntentEmitter (live)      │   │ IntentQuoteEmitter   (UUPS proxy, stable)  │
             │  NTT settlement           │   │   authPath = keccak256(terms)              │
             │  + forwarding instruction │   │   OrderPublished event (full terms)        │
             └─────────────┬─────────────┘   │   order VAA, consistency 202               │
                           │                 └─────────────────────┬─────────────────────┘
                           ▼                                       │
             ETHEREUM  IntentReceiver.processOrder                 │
                           │ native ETH → 0xN                      │
                           ▼                                       │
             POA  credits A                                        │
                           │                                       │
                           ▼                                       ▼
             NEAR  IntentRouter.finalize(terms, orderVaa)  ← pins IntentQuoteEmitter as emitter
                           └─→ swap | delivery | refund
```

- Price source, rail or fee changes → upgrade the dispatcher. The emitter's address never changes.
- The emitter's authorized set normally holds **one** dispatcher; a second only during a migration,
  and it must meet the current policy (every authorized dispatcher is a price authority for every path).

**Address derivation** (SDK, once per action, no transactions):

```
path = IntentQuoteEmitter.computeAuthPath(terms)                                   pure
A    = hex(v1.signer.derived_public_key({predecessor: router, path, domain_id: 1}))  NEAR view
0xN  = POA deposit_address({account_id: A, chain: "eth:1"})                        POA RPC
```

The SDK verifies `terms → A → 0xN` at confirmation. Nothing on-chain binds `depositAddress` to the
terms (POA's mapping is off-chain) — a disclosed trust boundary.

**Slippage.** ICE limits asset → WETH on Hydration (miss = no trade, free). The terms'
`maxSlippageBps` limits ETH → destination on NEAR (miss = hold in `A`). Fees between them are
disclosed, not bounded.

---

## 3. Data

Terms, `Order`, the order VAA, the ICE `data` layout, nonces and the router interface:
[schema.md](schema.md).

---

## 4. Build

### Hydration — `IntentCodec` v2

`Quote` and `encodeQuote` / `decodeQuote` / `authPath` per [schema.md](schema.md) §2 (decoder gains the semantic checks);
`encodeOrder` / `decodeOrder`.

### Hydration — `IntentQuoteEmitter` (never deployed; storage layout free)

- `publishOrder(terms, order)`, authorized dispatchers only (`order.seq` must come from a real
  `placeOrder`): `authPath = keccak256(encodeQuote(terms))`; require `outPerIn > 0`; publish at 202
  with `msg.value == messageFee()`; emit
  `OrderPublished(authPath, seq, dispatcher, amount, outPerIn, wormholeSequence, terms)`.
- `computeAuthPath` / `computeTerms` (pure); `setDispatcher(address, bool)`; v1 `publishQuote` removed.

### Hydration — `IntentDispatcher` (new; holds nothing between calls; `nonReentrant`)

- Config: `setRoute(asset, ethFeed, destFeed, destTokenDecimals)`, `setMaxFeedAge`, `setPoaMinimum`.
- `execute(user, intentId, assetIn, amountIn, assetOut, amountOut, data) returns (bytes4)`:
  1. require `assetOut == WETH`; decode `(depositAddress, maxRelayFee, terms)`;
  2. `outPerIn` from the route's two `IAggregatorV3` feeds — reject `answer ≤ 0`, age `> maxFeedAge`,
     zero, or above `uint128`;
     `outPerIn = mulDiv(ethUsd × 10^destFeedDec, 10^destTokenDec, destUsd × 10^ethFeedDec)`;
  3. `amount = amountOut − priceFee`; `minEthOut = ceil((poaMinimum + maxRelayFee) / 1e10) × 1e10`;
  4. `seq = placeOrder(WETH_ID, amount, minEthOut, depositAddress, maxRelayFee)` — the live emitter
     subtracts its cost, trims and enforces `minEthOut` itself;
  5. `publishOrder{value: priceFee}(terms, Order(seq, amount, outPerIn))`;
  6. emit `Dispatched(user, intentId, authPath, seq, depositAddress)`; return `execute.selector`.
- `dispatch(assetIn, amountIn, minEthOut, depositAddress, maxRelayFee, terms)` payable (exact price
  fee): pulls the caller's asset; same steps, with `minEthOut = max(caller's, the POA floor above)`.
- Unsolicited WETH is spendable by anyone — the dispatcher never holds reserves.

**Tests (Foundry):** codec bounds + raw-byte decoding + golden vectors; emitter authorization,
`authPath` derivation, 202, fee; dispatcher happy path, rate maths incl. 24-decimal NEAR, stale /
missing feeds, wrong `assetOut`, POA-floor edge with non-aligned fees, positive price fee on both
paths, reentrancy, stray balance.

**Migration `intent-mpc`:** deploy emitter · deploy dispatcher · authorize dispatcher · set routes ·
set max feed age · set POA minimum · transfer ownership (both).

### NEAR — `IntentRouter` (`crates/near/contracts/intent-router`)

Config: core, MPC signer, `intents.near`, emitter chain 73 + `IntentQuoteEmitter` address,
`price_validity`, `eth_token`, route registry (ledger id → token contract, decimals, withdrawal memo
rule, minimum), owner. Nothing per path.

```
finalize(terms, orderVaa)
  validate terms; path = keccak256(terms)
  1. v1.signer.derived_public_key(self, path, 1)  → A
  2. intents.mt_batch_balance_of(A, [eth, dest])   ‖   core.verify_vaa(orderVaa)  (only before the deadline)
  3. private callback, clock re-read:
       now > terms.deadline:
         eth ≥ refund minimum    → refund ETH → refundTo         (no registry, no VAA)
         else dest ≥ route min   → deliver dest → recipient
         else                    → nothing to do
       else:
         dest ≥ route min        → deliver dest → recipient       (failed-withdrawal recovery)
         VAA: chain 73, emitter, msgType ORDER, authPath == path, age ≤ price_validity
         amount_in = eth balance > 0
         floor_out = amount_in × outPerIn × (10_000 − slip) / (1e18 × 10_000)      U512, round down
         floor_out > 0 and floor_out × 1e18 ≥ amount_in × minOutPerIn            else hold (revert)
         sign swap: token_diff { eth −amount_in, dest +floor_out } + delivery → recipient
  4. v1.signer.sign({ request: { payload_v2: { Eddsa: hex(nep413 digest) }, path, domain_id: 1 } })
     → private on_signed: verify the signature locally → emit intent_signed

order expiry = min(terms.deadline, vaa.timestamp + price_validity)    payload deadline AND nonce expiry
swap nonce   = versioned(salt, order expiry, H(domain ‖ "swap" ‖ path ‖ seq)[..15])
refund / delivery nonces: H(domain ‖ action ‖ path ‖ block_height ‖ amount), explicit expiry
```

- Fixed order expiry ⇒ a re-sign reproduces the nonce (one fill per order) and nothing outlives
  its price.
- Every path to `sign` uses only terms (bound to `A` by the hash), a verified order VAA, the clock and
  balances. No admin or generic sign, no public callback. ETH → ETH routes rejected.
- Upgrade model from near-ntt (owner `upgrade` + `migrate`, two-step ownership, keys deleted,
  `cargo near build reproducible-wasm`). Sandbox tests against the pinned `intents.near` WASM.
- NEAR migration `intent-router`: deploy + init · propose owner · delete keys · accept by
  `hydration.sputnik-dao.near`.

### Bot (`agents/relayer`, `intent-near` app)

NEAR gas key only. Watch `OrderPublished` and `A`'s two balances; call `finalize` with the event's
terms and the order VAA; `publish_intent([], signed)`; poll `get_status`. On expiry: if the nonce is
unused and the VAA still valid, re-sign; otherwise wait for the next order or the deadline. Reconcile
from balances continuously (late credits, restored withdrawals, post-deadline refunds).

### Scan / SDK (minimal for MVP)

Scan: index `OrderPublished`, `Dispatched`, ICE forward failures, router `intent_signed`, settlement.
SDK: terms builder (random `quoteId`; tight DCA slippage, wider swap slippage; ICE schedule ends a
grace period before `terms.deadline`) → derivation → confirmation check → ICE submit or `dispatch`.

---

## 5. Gates

**Blocking the router (answer before Stage 3 merges):**

| Gate | Evidence |
| --- | --- |
| G1 solvers | a funded near-market order with `quote_hashes: []` is filled and delivered — including a multi-tranche catch-up size |
| G2 verifier | pinned `intents.near`: NEP-413 digest, versioned nonce bytes, deadline (incl. `== now`), swap + withdraw, failed withdrawal |
| G3 POA | contract-originated deposits credited; minimum; crediting p99; withdrawal fees and minimums |
| G6 MPC | live `v1.signer` request format, signature, deposit, gas, latency |

**Before the canary:** G4 feeds live on Hydration (Pyth pull receiver or the existing rail) ·
G5 ICE `Forward` in the target runtime within 2M gas · G7 router account and DAO handoff ·
G9 heartbeat alerting, failed-forward surfacing, balance reconciliation.

## 6. Stages

1. Hydration: codec, emitter, dispatcher, tests, migration.
2. Price feeds (G4).
3. NEAR router + sandbox + migration.
4. Bot. 5. Scan / SDK. 6. Audits (`/solidity-audit`, `/near-audit`), canary, remove 1Click.

---

## Appendix A — review disposition

From two independent review rounds (2026-10-13, 2026-10-14). Round-1 numbers 1–24, round-2
additions 25–29.

| # | Finding | Resolution |
| --- | --- | --- |
| 1, 26 | pacing; anyone can create an order for a path | accepted: one fill per order; a stranger's order triggers catch-up at the current oracle price, paying their own fees |
| 2, 14 | old signatures outlive price; nonce identity | fixed order expiry for payload and nonce; bot checks nonce before re-sign |
| 3, 8 | swap/refund race; forced early refund | refund only after deadline; swaps expire by the deadline; below floor holds |
| 4, 25 | stranded destination tokens; delivery starving refunds | delivery branch; after deadline ETH refund first; route minimums |
| 5 | observation age | accepted: during a feed outage the price can lag by up to `maxFeedAge`; shorten the heartbeat if G4 shows it is cheap |
| 6, 7 | rounding; integer widths | U512 multiply-compare, positive output, i128 bounds |
| 9 | ICE forwards not retried | surfaced; user recovers via `dispatch` |
| 10 | POA minimum after trimming | trim-aligned `minEthOut` enforced by the live emitter |
| 11 | MPC request format | `payload_v2` Eddsa; G6 |
| 12 | shared receiver replay | no change: instructions publish at 202 |
| 13 | terms ↔ deposit address | disclosed; SDK verifies at confirmation |
| 15, 16 | price expiry before crediting; schedule end | `price_validity` from measured p99; ICE cutoff before the deadline |
| 17, 18 | stray WETH; direct-path fee | no reserves held; `dispatch` payable |
| 19, 20, 27 | term validation; routing metadata; route changes vs refunds | checks in all decoders; route registry; refunds never read it |
| 21, 22, 24 | callbacks; events; implementation gap | private typed callbacks; full terms in `OrderPublished`; golden vectors |
| 23, 28 | trust table; dispatcher set | Appendix B; one authorized dispatcher in practice |
| 29 | `seq` namespace across rails | accepted: on a rail migration, bump the nonce domain (old VAAs are past `price_validity`) |

## Appendix B — trust and residuals

Trusted: Wormhole guardians · MPC network · POA custody and payout · `intents.near` governance
(pause, forced withdrawal roles) · router DAO (upgrade can redirect every `A`) · dispatcher owner
(price routes) · emitter owner (dispatcher set) · rail owners · the SDK's `terms → 0xN` mapping.

Residuals: solvers keep surplus above the floor; several valid orders of one path within
`price_validity` can be signed and the solver picks the lowest; a feed outage fails forwards (WETH
stays on Hydration) and can expire in-flight orders (funds hold, swaps may refund); refunds land as
ETH on Ethereum.

## Appendix C — deferred

Smoothed catch-up (`maxFillMultiple`) · relay quotes (Partner Portal key) · Dutch auction (stateful
router, one level per call — signing all levels up front does not work without a "valid from") ·
wNEAR rail · EMA price-agreement band · Hydration-return refunds.

## Appendix D — what this supersedes

The earlier MPC-variant design: a per-tranche priced quote triggered by a "DCA pallet",
`finalize(vaa)` with router state, no exit, `contract.wormhole.near`; `IntentQuoteEmitter` v1
(`publishQuote` over Wormhole at 200); the "prefer an immutable router" stance; earlier revisions of
this plan.
