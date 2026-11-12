# PLAN — Intents v2 MVP

Status: **contracts built and audited; deployment pending.** Branch `feat/intent-v2`. Design:
[spec.md](spec.md). Data formats: [schema.md](schema.md).

**Goal.** Unattended swaps and DCA from Hydration into any asset 1Click can buy on NEAR Intents: one
**reusable deposit address per action** (a swap, or a whole DCA), each execution priced **on-chain**
on Hydration, executed with nobody present.

---

## 1. Decisions

| #   | Decision                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Value path: Hydration WETH → NTT with a forward payload → `IntentForwarder` → native ETH to POA's `0xN` → credited to NEAR account `A`. The v1 rail (`IntentEmitter` / `IntentReceiver`) is not used. |
| D2  | Triggered by ICE `OnResolved::Forward` → `IntentDispatcher.execute`, or directly via `IntentDispatcher.dispatch`. WETH only; only the terms' `owner` places their orders.                             |
| D3  | **One action = one set of terms = one `A` = one `0xN`.** Terms travel inside every order; there is no separate terms publication.                                                                     |
| D4  | **Price bound to the order:** each execution publishes one order VAA `(authPath, seq, amount, outPerIn)` from the dispatcher.                                                                         |
| D5  | `IntentDispatcher` is one UUPS proxy holding all Hydration logic. ICE intents, the forwarder and the router pin its address.                                                                          |
| D6  | NEAR `IntentRouter` is stateless (config only), DAO-upgradeable like the near-ntt manager, at `intents-router.hydration-whm.near`.                                                                    |
| D7  | **`swap(terms, orderVaa, quote)`, `deliver(terms)`, `refund(terms)`.** The swap goes through a 1Click quote the router verifies and floors at the order's rate. No quote, no swap.                    |
| D8  | Refund **only after the deadline**; below the hard floor funds hold.                                                                                                                                  |
| D9  | **Catch-up:** each fill spends `A`'s ETH up to `max_fill_multiple × order.amount`; one fill per order.                                                                                                |
| D10 | No price refresh: DIA feeds on Hydration, updated on deviation; the dispatcher refuses an answer older than `maxFeedAge`.                                                                             |
| D11 | `order.amount` is net of the relay ceiling, which is capped at half of what bridges — so with `max_fill_multiple ≥ 2` one fill takes what landed.                                                     |
| D12 | The bot is NEAR-only and untrusted (gas key only); the Ethereum relayer is paid from the order's ceiling.                                                                                             |

---

## 2. Architecture

```
                 ICE intent (on_resolved)            owner (direct)
                          │                                │
                          ▼                                ▼
             ┌──────────────────────────────────────────────────────────────┐
             │ IntentDispatcher   (UUPS proxy, Hydration)                   │
             │   execute(…)   ICE callback, as the owner                    │
             │   dispatch(…)  direct, pulls WETH                            │
             │   price route → two feeds → outPerIn (stale reverts)         │
             └──────────────┬───────────────────────────────┬───────────────┘
                            │                               │
      NttManagerWithPayload.transferWithPayload    order VAA, consistency 202
        payload: depositAddress | maxRelayFee        (authPath, seq, amount, outPerIn)
                            │                               │
                            ▼                               │
             ETHEREUM  IntentForwarder.processOrder         │
                       deliver · fee → relayer · ETH → 0xN  │
                            │                               │
                            ▼                               │
             POA  credits A                                 │
                            │                               │
                            ▼                               ▼
             NEAR  IntentRouter.swap(terms, orderVaa, 1Click quote)   ← pins the dispatcher as emitter
                   IntentRouter.deliver(terms) · refund(terms)
```

**Address derivation** (SDK, once per action, no transactions):

```
path = IntentDispatcher.computeAuthPath(terms)                                     pure
A    = hex(v1.signer.derived_public_key({predecessor: router, path, domain_id: 1}))  NEAR view
0xN  = POA deposit_address({account_id: A, chain: "eth:1"})                        POA RPC
```

The SDK verifies `terms → A → 0xN` at confirmation. Nothing on-chain binds `depositAddress` to the
terms (POA's mapping is off-chain) — a disclosed trust boundary.

**Slippage.** ICE limits asset → WETH on Hydration (miss = no trade, free). The terms'
`maxSlippageBps` limits ETH → destination on NEAR (miss = hold in `A`). Fees between them — NTT
delivery, the relay fee, POA, 1Click — are disclosed, not bounded.

---

## 3. Built

| Component                                  | Where                                                        | State                                                |
| ------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------- |
| `IntentCodec`, `IntentDispatcher`          | `contracts/src/intents-v2/`                                  | done; `/solidity-audit` 2026-11-11, findings fixed   |
| `IntentForwarder`, `NttPayload.transferOf` | `contracts/src/intents-v2/`, `contracts/src/ntt/`            | done; same audit                                     |
| `NttManagerWithPayload`                    | hydration-ntt `ecb06683`                                     | done; 256-byte payload cap                           |
| `IntentRouter` + sandbox                   | `crates/near/contracts/intent-router`, `crates/near/sandbox` | done; `/near-audit` 2026-10-26, delta review pending |
| Router scripts                             | `crates/near/scripts/intent-router/`                         | done: derive, swap, payout                           |

Golden vectors pin the terms, path and order message across Solidity, Rust and TypeScript.

---

## 4. To build

### Migrations — after every contract is final

Deploy the proxies first, then wire them — each pins the others' addresses.

- **Hydration:** deploy `IntentDispatcher` · `setNttManager` (the payload-capable WETH manager) ·
  `setForwarder` · `setPriceRoute` per destination · `setMaxFeedAge` · `setMinOrderAmount` (POA's
  1e11 wei) · owner handoff.
- **Ethereum:** deploy `IntentForwarder` (wormhole, WETH transceiver) · `setDispatcher` · relayer
  allowlist · owner handoff.
- **NEAR `intent-router`:** deploy + init (emitter = the dispatcher on chain 73, quote keys, params:
  `max_fill_multiple ≥ 2`, `max_order_shortfall_bps` ≈ 100 until a canary shows POA credits exactly)
  · propose owner · delete keys · accept by `hydration.sputnik-dao.near`. `cargo near build`, never
  plain `cargo build`.
- **NTT:** upgrade Hydration's WETH manager to `NttManagerWithPayload` (governance proposal); confirm
  the Ethereum manager parses a payload transfer.

### Bot (`agents/relayer`, `intent-near` app)

NEAR gas key only. Watch `OrderPublished` and `A`'s balances. Per order, once POA has credited:
quote 1Click for `min(A's ETH, cap)`, `router.swap`, submit to 1Click, poll its status. Deliver once
`A` holds `minDelivery`; refund after the deadline. Reconcile from balances continuously (late
credits, 1Click refunds, failed withdrawals).

### Relayer (`agents/relayer`, Ethereum)

Watch NTT transfers from the dispatcher; `processOrder(nttVaa, fee)` with the fee sized from the
real call and bounded by the payload's ceiling. Authorized relayers get a 5-minute head start.

### Scan / SDK

Scan: `OrderPublished`, ICE forward failures, `OrderForwarded`, router `intent_signed`, 1Click
status. SDK: terms builder (owner = the ICE caller address, random `quoteId`, `maxRelayFee` ≤ half
the smallest order, ICE schedule ending a grace period before `terms.deadline`) → derivation →
confirmation check → ICE submit or `dispatch`.

---

## 5. Gates

**Done** — run on mainnet, [verification.md](verification.md): G1 1Click as counterparty (a
router-built transfer into a verified quote fills) · G2 the bytes `intents.near` verifies · G3 POA
credits a contract's ETH · G6 the live `v1.signer` request.

**Before the canary:**

| Gate              | Evidence                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| G4 feeds          | DIA routes set for each destination; `maxFeedAge` against observed update gaps                                               |
| G5 ICE            | `Forward` in the live runtime; `execute` within 2M gas on a fork, including the existential deposit on the dispatcher's dust |
| G7 router account | `intents-router.hydration-whm.near` controlled; DAO handoff                                                                  |
| G8 NTT payload    | Hydration WETH manager upgraded; a payload transfer delivered through the Ethereum manager on a fork                         |
| G9 monitoring     | stale feeds, failed forwards, queued settlements, balance reconciliation                                                     |
| G10 refunds       | 1Click refunding `A`, and the router's post-deadline refund, run once                                                        |
| G11 router gas    | static gas of `swap`, `deliver`, `refund` measured on testnet                                                                |

## 6. Stages

1. ~~Hydration dispatcher, codec · Ethereum forwarder · NEAR router + sandbox · audits.~~
2. Router delta review (`/near-audit`).
3. NTT payload managers (G8) · fork gas check (G5).
4. Migrations, three chains.
5. Bot and relayer. 6. Scan / SDK. 7. Canary.

---

## Appendix A — trust and residuals

Trusted: Wormhole guardians · WETH NTT manager owners (Hydration governance) · MPC network · POA
custody and payout · `intents.near` governance (pause, forced withdrawal roles) · 1Click (quote keys,
deposit accounts) · router DAO (upgrade can redirect every `A`) · dispatcher owner (price routes,
minimums, manager, forwarder, upgrade) · forwarder owner (dispatcher pin, relayers, upgrade) · the
SDK's `terms → 0xN` mapping.

Residuals: solvers keep surplus above 1Click's quote; the bot chooses when to quote within an
order's price validity; a feed outage fails forwards (WETH stays on Hydration) and can expire
in-flight orders (funds hold until the next order or the deadline); a full outbound rate limit fails
forwards the same way; refunds land as ETH on Ethereum.

## Appendix B — deferred

Dutch auction (stateful router, one level per call) · relay quotes (Partner Portal key) · EMA
price-agreement band · Hydration-return refunds · other destination kinds.
