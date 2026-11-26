# PLAN — Intents v2

Status: **deployed on mainnet (2026-11-17); a canary and ICE swap and TWAP runs delivered to Zcash
(2026-11-19). Close/settle and NEAR delivery built, upgrade pending; ownership handover pending.** Branch `feat/intent-v2`. Design: [spec.md](spec.md). Data
formats: [schema.md](schema.md). Payout paths and fees: [payout.md](payout.md).

**Goal.** Unattended swaps and TWAPs from Hydration into any asset 1Click can buy on NEAR Intents: one
**reusable deposit address per action** (a swap, or a whole TWAP), each execution priced **on-chain**
on Hydration, executed with nobody present.

---

## 1. Decisions

| #   | Decision                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Value path: Hydration WETH → NTT with a forward payload → `IntentForwarder` → native ETH to `0xN`, a standing 1Click pass-through → credited to NEAR account `A`.                  |
| D2  | Triggered by ICE `OnResolved::Forward` → `IntentDispatcher.execute`, or directly via `IntentDispatcher.dispatch`. WETH only; only the terms' `owner` places their orders.          |
| D3  | **One action = one set of terms = one `A` = one `0xN`.** Terms travel inside every order; there is no separate terms publication.                                                  |
| D4  | **Price bound to the order:** each execution publishes one order VAA `(authPath, seq, amount, outPerIn)` from the dispatcher.                                                      |
| D5  | `IntentDispatcher` is one UUPS proxy holding all Hydration logic. ICE intents, the forwarder and the router pin its address.                                                       |
| D6  | NEAR `IntentRouter` is stateless (config only), DAO-upgradeable like the near-ntt manager, at `intents-router.hydration-whm.near`.                                                 |
| D7  | **`swap(terms, orderVaa, quote)`, `deliver(terms)`, `refund(terms)`.** The swap goes through a 1Click quote the router verifies and floors at the order's rate. No quote, no swap. |
| D8  | Refund **only after the deadline**; below the hard floor funds hold.                                                                                                               |
| D9  | **Catch-up:** each fill spends `A`'s ETH up to the terms' `maxFillMultiplier × order.amount`; one fill per order.                                                                  |
| D10 | No price refresh: DIA feeds on Hydration, updated on deviation; the dispatcher refuses an answer older than `maxFeedAge`.                                                          |
| D11 | `order.amount` is net of the relay ceiling, which is capped at half of what bridges — so with `maxFillMultiplier ≥ 2` one fill takes what landed.                                  |
| D12 | The NEAR bot is untrusted (gas key only); the Ethereum relayer is paid from the order's ceiling.                                                                                   |
| D13 | **`close(terms, delay)` / `settle(terms, closeVaa)`:** the owner ends terms early (no more orders, a close message); after `delay` ≤ 1 day anyone settles `A` — no quote.          |
| D14 | NEAR is delivered as native NEAR (`native_withdraw` of `nep141:wrap.near`), as v1 and 1Click pay it.                                                                               |
| D15 | Withdrawals only through UTXO routes — Omni's ZEC and nBTC via `withdraw-zec` / `withdraw-btc` — or as native NEAR. POA carries only the ETH refunds.                              |

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
             1CLICK  POA credits its account, forwards to A │
                            │                               │
                            ▼                               ▼
             NEAR  IntentRouter.swap(terms, orderVaa, 1Click quote)   ← pins the dispatcher as emitter
                   IntentRouter.deliver(terms) · refund(terms)
```

**Address derivation** (once per action, no transactions):

```
path = IntentDispatcher.computeAuthPath(terms)                                     pure
A    = hex(v1.signer.derived_public_key({predecessor: router, path, domain_id: 1}))  NEAR view
0xN  = 1Click standing pass-through to A (ANY_INPUT, recipient = refundTo = A)       1Click API, partner key
```

Nothing on-chain binds `depositAddress` to the terms (1Click's pass-through is off-chain) — a disclosed
trust boundary.

**Slippage.** ICE limits asset → WETH on Hydration (miss = no trade, free). The terms'
`maxSlippageBps` limits ETH → destination on NEAR (miss = hold in `A`). Fees between them — NTT
delivery, the relay fee, the pass-through, 1Click's swap, the payout — are disclosed, not bounded.

---

## 3. Deployed

| Component                            | Where                                                                                        | State                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `IntentDispatcher` (+ `IntentCodec`) | Hydration `0x2c967d7e00a18c1c926fd77de733a27c3fdb3f2b`                                       | live; upgraded to emit `OrderSourced` from ICE    |
| `NttManagerWithPayload` (WETH)       | Hydration `0xB5cEf790D52A57fa619eD96eDd64c5328F3DCFb7`                                       | live; 256-byte payload cap                        |
| `IntentForwarder`                    | Ethereum `0x31ab66509a8a0b5a0fdf33ff4a4297481863035c`                                        | live; one authorized relayer                      |
| `IntentRouter`                       | NEAR `intents-router.hydration-whm.near`                                                     | live; owner `hydration-whm.near`, key not deleted |
| Ethereum relayer                     | `agents/relayer`, `intent-v2` app                                                            | live                                              |
| NEAR router bot                      | `agents/intent`, `router` app — reads `/api/terms` and events from scan                      | live                                              |
| Scan                                 | `agents/scan`, `intents-v2` app; `/v2/trades`, `/v2/trade`, `/v2/order`                     | live                                              |
| Helpers and scripts                  | `common/{evm,near}/intents.ts`; `contracts/scripts/intentsV2{SwapAlpha,TwapAlpha}.ts`        | done                                              |
| Migration                            | `migrations/definitions/intents-v2`, record `deployments/prod/intents-v2.json`               | steps 001–014 done; handover in `intents-v2-dao`  |

Live settings: `maxFeedAge` 21600 s; `minOrderAmount` 1e11 wei; one price route, `nep141:zec.omft.near`.
Router params: `price_validity` 900 s, `max_quote_age` 30 s, `transfer_validity` 180 s,
`min_quote_slippage_bps` 100, `max_order_shortfall_bps` 100, `min_refund` 1e14 wei.

Golden vectors pin the terms, path and order message across Solidity, Rust and TypeScript.

### SDK defaults — the alpha scripts

- **Swap** (`intentsV2SwapAlpha`) — `maxFillMultiplier` 2; `maxSlippageBps` 300; hard floor 20% under
  the dispatcher's `outPerIn`; terms deadline = the ICE intent's deadline + 1 h.
- **TWAP** (`intentsV2TwapAlpha`, an ICE `Dca` intent) — period 150 blocks (~5 min at Hydration's ~2 s blocks; ICE's minimum
  is 15); `maxFillMultiplier` = the number of tranches (2..100); ICE slippage 3%; no ICE deadline
  (ICE refuses one on a `Dca` intent); terms deadline = the schedule + 2 h.
- **Both** — `--dest zec | btc | near`; relay ceiling = the quoter's estimate + 20% (the dispatcher
  refuses one above half the order); `minDelivery` 1 by default, i.e. a payout as soon as the route's
  minimum lands — set it higher to batch tranches into fewer payouts. Before anything is spent the
  recipient is checked as the router will pay it (the route's withdraw contract validates a ZEC/BTC
  address, a NEAR recipient must exist) and the expected output against the route's minimum.
- **Swap only** — `--direct` dispatches the signer's WETH without ICE; `--refundTest` sets an
  unreachable floor and a 20-minute deadline, so the bot refunds the ETH.

---

## 4. Remaining

- **Close/settle, UTXO, NEAR and BTC** — dispatcher and router upgraded 2026-11-24; `utxo-withdraw-btc`,
  then `intents-v2` 011–014 (NEAR and nBTC price routes, the ZEC and nBTC UTXO routes); canaries: a
  short TWAP closed, ZEC to a `t1` address, nBTC to a `bc1q` address, a NEAR swap.
- **Ownership handover** — the `intents-v2-dao` migration: forwarder and dispatcher to their owners; the
  router proposed to `hydration.sputnik-dao.near`, its full-access key deleted, the DAO accepts.
- **Refunds** — run once: 1Click refunding `A` (a swap that does not fill) and the router's
  post-deadline refund.
- **Monitoring** — alerts on stale feeds, failed ICE forwards, queued settlements, the bot's NEAR
  balance and `A` balances left behind.
- **More destinations** — a price route per asset (`setPriceRoute`).

---

## 5. Gates

| Gate              | State                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------- |
| G1 counterparty   | done 2026-10-21 — a router-built transfer into a verified 1Click quote fills             |
| G2 signed bytes   | done 2026-10-21 — the bytes `intents.near` verifies                                      |
| G3 deposit        | done 2026-10-21 — POA credits ETH a contract forwards; the pass-through since 2026-11-19 |
| G4 feeds          | done — ZEC route set, `maxFeedAge` 6 h                                                   |
| G5 ICE            | done 2026-11-19 — an ICE swap and a 3-tranche TWAP forwarded into `execute`              |
| G6 `v1.signer`    | done — the live sign request                                                             |
| G7 router account | controlled; DAO handoff open                                                             |
| G8 NTT payload    | done 2026-11-19 — payload transfers delivered through the Ethereum manager               |
| G9 monitoring     | scan shows every stage; alerting open                                                    |
| G10 refunds       | open                                                                                     |
| G11 router gas    | done — mainnet: `swap` ~0.0038 NEAR, `deliver` ~0.0029 NEAR                              |

Evidence: [verification.md](verification.md).

---

## Appendix A — trust and residuals

Trusted: Wormhole guardians · WETH NTT manager owners (Hydration governance) · MPC network · POA
custody and payout · `intents.near` governance (pause, forced withdrawal roles) · 1Click (quote keys,
deposit accounts, the standing pass-through to `A`) · router DAO (upgrade can redirect every `A`) ·
dispatcher owner (price routes, minimums, manager, forwarder, upgrade) · forwarder owner (dispatcher
pin, relayers, upgrade) · the SDK's `terms → 0xN` mapping.

Residuals: solvers keep surplus above 1Click's quote; the bot chooses when to quote within an
order's price validity; a feed outage fails forwards (WETH stays on Hydration) and can expire
in-flight orders (funds hold until the next order or the deadline); a full outbound rate limit fails
forwards the same way; refunds land as ETH on Ethereum.

## Appendix B — deferred

Dutch auction ([dutch-auction.md](dutch-auction.md); stateful router, one level per call) · relay
quotes (Partner Portal key) · EMA price-agreement band · Hydration-return refunds · other destination
kinds.
