# Intents

## Abstract

Hydration users hold assets and want assets on chains Hydration doesn't reach — Bitcoin, Zcash, Solana SPLs, NEAR-native tokens. NEAR Intents already settles swaps across all of these chains through the Defuse / OneClick flow. Near Intents Bridge connects the two: a single Hydration extrinsic swaps the user's chosen Hydration asset to WETH, bridges it to Ethereum via Moonbeam + Wormhole, and forwards native ETH into the quote-specific `depositAddress` returned by the OneClick API. After that deposit tx lands, `nintent` calls `submitDepositTx({ depositAddress, txHash })` so the quoted swap can continue and a solver delivers the destination asset (e.g. ZEC) to the user's wallet on the destination chain.

## Overview

The bridge composes two existing systems: **Basejump** (fast-path delivery against a pre-funded EVM pool, replenished by the slow Wormhole TokenBridge transfer) and **NEAR Intents / Defuse OneClick** (origin-chain deposits → quoted destination asset, solver settled). On Hydration, a new `IntentEmitter` contract, in one atomic extrinsic via the DISPATCH precompile: (1) buys a fixed GLMR cross-chain fee and swaps the rest of the user's asset to WETH on the Hydration router, then (2) dispatches `batch_all([reserve-transfer WETH+GLMR to its Moonbeam MDA, send→Transact])`. The Transact runs **as the MDA** on Moonbeam and calls `BasejumpProxy.bridgeViaWormhole(WETH, …, recipient = IntentRouter, data = (intentId, depositAddress))`, which fires Basejump's two paths: a slow Wormhole **TokenBridge** transfer that replenishes the Ethereum landing pool (~13 min) and an instant fast-path VAA (~2 min). On Ethereum the fast VAA delivers through `Basejump → BasejumpLanding → IntentRouter`, which forwards native ETH to the OneClick `depositAddress`. The off-chain orchestrator `nintent` only nudges OneClick's deposit detector. The user obtains a live OneClick quote off-chain for `originAsset = ETH.eth`; everything after `IntentEmitter.swapAndBridge(...)` is automated.

## V1 Scope

- Two new contracts:
  - `IntentEmitter` on Hydration — swaps any Hydration asset → WETH and initiates the cross-chain bridge in one extrinsic
  - `IntentRouter` on Ethereum (`IBasejumpReceiver`, forwards native ETH to the quote deposit address)
- Source asset (user side): **any Hydration asset** `A` the router can sell to WETH (GLMR and WETH are special-cased). The bridged/origin asset for the quote is **ETH** (WETH on Hydration/Moonbeam → native ETH at the deposit address).
- Asset transport: **XCM reserve-transfer** Hydration → Moonbeam (WETH + GLMR to the emitter's MDA), then Wormhole **TokenBridge** Moonbeam → Ethereum (~13 min) — replenishes the `BasejumpLanding` pool.
- Trigger transport: the same `BasejumpProxy.bridgeViaWormhole` call publishes the fast-path Wormhole VAA (~2 min) alongside the TokenBridge transfer — both legs originate from one Moonbeam call, so they are inherently paired and self-funding (the call pulls and locks the WETH it bridges).
- Intent hop: Ethereum ETH → OneClick quote deposit → NEAR Intents → destination asset on destination chain
- Quote model: `OneClickService.getQuote(originAsset = ETH.eth, ...)` returns quote details plus a quote-specific `depositAddress` on Ethereum
- Completion model: OneClick auto-detects deposits on `depositAddress` and starts processing on receipt; `OneClickService.submitDepositTx({ depositAddress, txHash })` is an optional latency optimization (~poller interval → ~seconds)
- Basejump payload extension: the VAA carries opaque `bytes data`, forwarded by `BasejumpLanding` to receiver contracts via the `onBasejumpReceive` callback
- Landing asset remap: `BasejumpLandingNative.destAssetFor` maps the source-chain asset address to the destination payout asset (an ERC20, or the `NATIVE` sentinel for native ETH) — the source contract cannot know the destination asset id, so the landing owns the mapping
- EVM forward step is **atomic** with Basejump fast-path delivery — no keeper involvement, reverts together
- Hydration-side dispatch is **atomic** in one extrinsic — swap + `batch_all` either all apply or none do
- Single `nintent` headless keeper: watches `IntentForwarded` events on `IntentRouter` and calls `OneClick.submitDepositTx({ depositAddress, txHash })` as a latency optimization. OneClick auto-detects deposits without it; nintent just makes detection ~seconds instead of one poller interval. No HTTP API, no quote-path involvement, no per-quote registry. Quote acquisition is UI ↔ OneClick direct. Failure unwind is operator-driven outside the agent.
- Supported destinations: any NEAR Intents-listed asset/chain pair supported by the quote API (ZEC/Zcash, BTC/Bitcoin, NEAR/NEAR, …)
- No on-chain failure handling — happy path only; expired or rejected quotes are unwound off-chain (see [refund.md](refund.md))
- No shared NEAR recipient account in the NIR path — the quote's origin-chain `depositAddress` is used directly

## Architecture

Four layers — Hydration entry (`IntentEmitter`: swap + dispatch), the Moonbeam hop (`BasejumpProxy` via the emitter's MDA), Ethereum delivery (`Basejump` → `BasejumpLanding` → `IntentRouter`), and the `nintent` off-chain orchestrator. The asset and the trigger travel the **same** route (Hydration → Moonbeam → Wormhole → Ethereum); the slow TokenBridge transfer and the fast VAA both originate from one `bridgeViaWormhole` call.

### Hydration — `IntentEmitter`

The entry point on Hydration. Holds no liquidity in the happy path. Swaps the user's asset to WETH, reserves a GLMR fee for the cross-chain hop, and dispatches the bridge — all in one extrinsic through the DISPATCH precompile (`0x0401`). UUPS-upgradeable.

**Storage / config:**

- `owner` / `xcmOperators` — owner controls upgrades, router/proxy wiring; xcm operators tune fee/gas params
- `basejumpProxy` — address (H160) of `BasejumpProxy` on Moonbeam
- `intentRouter` — `bytes32` Wormhole recipient: the Ethereum `IntentRouter` the fast-path payout targets
- `xcmSource` — the emitter's Moonbeam **MDA** (derived sibling-EVM AccountId32 → H160), computed at init; the assets are reserve-transferred to it and the Transact runs as it
- `xcmFee` / `xcmExecutionFee` / `xcmGasLimit` / `xcmTransactRefTime` / `xcmTransactProofSize` — XCM transport/weight parameters (operator-tunable via `setXcmParams`)
- constant `ETHEREUM_WORMHOLE_ID = 2`

**`swapAndBridge(uint32 assetIn, uint256 amountIn, uint256 minEthOut, uint256 maxFeeIn, bytes32 intentId, address intentDepositAddress)`** — single user entry. In one extrinsic:

1. Pulls `amountIn` of asset `A` (`assetIn`) from the caller.
2. **Swap** (`_swap`): reserve the fixed `xcmFee` of GLMR for the hop, then convert the rest of `A` to WETH on the Hydration router.
   - `A == GLMR`: withhold `xcmFee`, sell `amountIn − xcmFee` → WETH.
   - else: buy `xcmFee` GLMR with `A`, spending at most `maxFeeIn` of `A` (caller's fee-leg slippage bound); then sell the caller's leftover `A` → WETH (skipped when `A == WETH`).
3. Slippage check: `wethOut` (WETH produced this call) must be `≥ minEthOut`, else revert `InsufficientOutput`.
4. **Bridge** (`_bridge`): DISPATCH `utility.batch_all([` `polkadotXcm.transfer_assets_using_type_and_then` (reserve-transfer `[GLMR fee, WETH]` to the MDA on Moonbeam)`,` `polkadotXcm.send` → Transact **as the MDA** running Moonbeam's Batch precompile: `WETH.approve(basejumpProxy, ethOut)` then `BasejumpProxy.bridgeViaWormhole(WETH, ethOut, ETHEREUM_WORMHOLE_ID, intentRouter, abi.encode(intentId, intentDepositAddress))` `])`.
5. Emits `BridgeInitiated(intentId, caller, assetIn, amountIn, ethOut, intentDepositAddress)`.

If any step fails the whole extrinsic reverts — no partial state. Only the caller's own `A` is swapped; stray/donated `A` resident in the contract is left untouched. See [fee.md](fee.md) for sizing `amountIn` / `minEthOut` / `maxFeeIn`.

### Moonbeam hop — the emitter's MDA + `BasejumpProxy`

The reserve-transfer credits the emitter's **Multilocation Derived Account** (`xcmSource`) on Moonbeam with the WETH + GLMR, and the `send` leg's Transact executes _as that MDA_ (sovereign origin). The Batch precompile approves the proxy and calls `bridgeViaWormhole`, which:

- **Slow path** — `TokenBridge.transferTokens(WETH, actualAmount, destChain = Ethereum, destLanding, …)` locks WETH on Moonbeam and delivers the canonical asset to the Ethereum `BasejumpLanding` pool (~13 min), replenishing what the fast path pays out.
- **Fast path** — `_fastTrack` publishes a Wormhole VAA with `netAmount = actualAmount − assetFee[WETH]`, `recipient = IntentRouter`, and the opaque `data`.

`bridgeViaWormhole` is **self-funding** (it pulls and locks `actualAmount` via `transferFrom`), so no caller whitelist is needed — the slow replenishment and the fast payout always carry matching value, and the VAA emitter check on Ethereum is the trust boundary.

### Basejump payload extension (generic, reusable)

`IntentRouter` relies on a small generic extension to Basejump that benefits any contract recipient:

- `BasejumpProxy.bridgeViaWormhole(asset, amount, destChain, recipient, bytes data)` — the fast-path VAA payload encodes `(sourceAsset, netAmount, recipient, data)`. `data` is opaque bytes chosen by the caller.
- `BasejumpLanding(Native).transfer(sourceAsset, amount, recipient, bytes data)` — after delivering the payout asset, if `data.length > 0` it atomically calls `IBasejumpReceiver(recipient).onBasejumpReceive(destAsset, amount, data)`. When `data` is non-empty the recipient MUST be a contract (validated up-front so a malformed delivery can't wedge the FIFO queue). Plain transfers (`data.length == 0`) behave as a normal payout.
- Reverts in `onBasejumpReceive` bubble up and revert the entire `Basejump.completeTransfer`. The slow TokenBridge leg still settles into the pool regardless, so liquidity is never stranded.

### Ethereum — `Basejump` and `BasejumpLanding(Native)`

- `Basejump.completeTransfer(vaa)` verifies the VAA, decodes the `TransferPayload`, and calls `BasejumpLandingNative.transfer(sourceAsset, netAmount, recipient, data)`.
- `BasejumpLandingNative` is a **pre-funded pool** that maps `sourceAsset → destAsset` via `destAssetFor` (set by the owner; `setDestNative` for the native case). For the intents flow the Moonbeam-WETH source maps to **`NATIVE`**, so the pool pays out **native ETH** via `call{value:}`; for plain ERC20 bridging it pays the mapped ERC20. The mapping exists because the source contract emits a source-chain asset address that is not the destination asset address.
- If the pool is short at delivery time the transfer is **queued** and anyone can drain it later via `fulfillPending` once the slow path replenishes. The receiver callback fires on delivery (immediate or at queue-drain).
- The native pool is funded with ETH and replenished by the slow Wormhole transfer (which arrives as WETH); the WETH→ETH unwrap of replenishment is an operational step (off-chain keeper or a permissionless unwrap helper). The per-transfer Basejump `assetFee[WETH]` must cover the Wormhole 8-decimal normalization dust so the pool stays solvent — see [fee.md](fee.md).

### Ethereum — `IntentRouter`

A single Ethereum contract that holds no liquidity, only routes. Implements `IBasejumpReceiver`. The payout asset arrives from `BasejumpLanding` — native ETH (via `call{value:}`, accepted by the router's `receive()`) or an ERC20 — immediately before the callback; the router forwards the same amount to the quote-specific `depositAddress` in the same transaction.

**Storage:**

- `owner`
- `basejumpLanding` (address) — the only authorized caller of `onBasejumpReceive`
- constant `NATIVE` sentinel — matches `BasejumpLandingNative.NATIVE`

No replay mapping is needed: a Basejump VAA can only be redeemed once, and `data` is bound to that VAA, so the `(intentId, depositAddress, amount)` tuple cannot reach the router twice.

**`onBasejumpReceive(address asset, uint256 amount, bytes calldata data)`** — invoked by `BasejumpLanding` atomically with delivery. Not payable; native ETH is received via the router's `receive()` just before this call.

1. Requires `msg.sender == basejumpLanding`
2. Requires `data.length == 64` (else `MalformedData`)
3. Decodes `(intentId, depositAddress)` from `data`; requires `depositAddress != 0`
4. Forwards `amount` of `asset` to `depositAddress` — native ETH via `call{value: amount}` when `asset == NATIVE`, else `IERC20(asset).safeTransfer` (`_forward`)
5. Emits `IntentForwarded(intentId, asset, depositAddress, amount)`

Any revert in this path bubbles up and reverts the entire `Basejump.completeTransfer`. The slow path still lands the asset in `BasejumpLanding`, so funds are never stranded at the router.

**`sweep(asset, to, amount)`** — owner-only escape hatch for stuck funds (native ETH via `asset == NATIVE`, or stray tokens). **`setBasejumpLanding` / `setOwner`** — owner-only wiring.

### Off-chain — `nintent` orchestrator

Long-running TypeScript service, structured like the existing `agents/bjscan` and `agents/broadcaster` packages. Bundles to a single `dist/index.js` via the shared [esbuild.config.mjs](../../esbuild.config.mjs).

**Responsibilities (the whole list):**

1. **Forward watcher** — subscribes to `IntentForwarded(intentId, asset, depositAddress, amount)` events on `IntentRouter`. Captures `depositAddress` and the Ethereum tx hash from the event; no prior registration is needed.
2. **Deposit submitter** — calls `OneClickService.submitDepositTx({ depositAddress, txHash })` for each observed event.

`submitDepositTx` is **not required for the swap to complete**. OneClick polls the origin chain for the `depositAddress` it issued and starts processing on receipt automatically. The agent exists only to compress detection latency from a poller interval (potentially tens of seconds) to ~seconds by pushing the tx hash to OneClick as soon as the on-chain event fires.

That's it. `nintent` exposes no HTTP API and stores no per-quote registry. The UI talks to OneClick directly for quote acquisition and status polling. The orchestrator has no role in quote acquisition and no role in the EVM-side forward (atomic with Basejump delivery). If the agent is down, swaps still complete — just slower.

Operator-driven failure unwind (expired quote, rejected deposit) is a manual process handled outside the agent in V1 — no automated logic lives in `nintent` for it. See [refund.md](refund.md).

**Intent ID** = local correlation hash computed by the UI from the accepted quote, for example:

`keccak256(abi.encode(quoteId, depositAddress, srcAmount, destAsset, destRecipient, deadline, nonce))`

The same hash is used as:

- the `intentId` argument to `IntentEmitter.swapAndBridge(...)` and in the Basejump `data` payload, carried end-to-end into `IntentRouter.onBasejumpReceive`
- the first field of the `IntentForwarded` event, observable on-chain
- the correlation key in logs and analytics (joining Hydration `BridgeInitiated`, Ethereum `IntentForwarded`, and OneClick status records off-chain)

### NEAR side — third-party

Near Intents Bridge does not deploy anything on NEAR. It relies on the existing quote / deposit pipeline:

| Component                   | Role                                                                   |
| --------------------------- | ---------------------------------------------------------------------- |
| Defuse / OneClick quote API | Returns quote details, `depositAddress`, and accepts `submitDepositTx` |
| `intents.near`              | Solver settlement and destination execution                            |
| Solvers                     | Provide destination asset (ZEC, BTC, …) on destination chain           |

## Flow

See [schema.md](schema.md) for full chain-hop diagrams.

End-to-end happy path:

1. **Quote** — the UI calls the Defuse / OneClick API directly for `ETH.eth → destination asset`. The API returns quoted output, expiry, and `quote.depositAddress` on Ethereum (plus optional memo).
2. **Accept** — user reviews and accepts the live quote in the UI. The UI computes the local `intentId` and sizes `amountIn` / `minEthOut` / `maxFeeIn` (reading `assetFee[WETH]` and the `A/GLMR`, `A/WETH` prices — see [fee.md](fee.md)). `nintent` is not involved.
3. **Hydration atomic dispatch** — user calls `IntentEmitter.swapAndBridge(assetIn, amountIn, minEthOut, maxFeeIn, intentId, depositAddress)`. In one extrinsic the emitter buys the GLMR fee, swaps `A → WETH`, and dispatches `batch_all([reserve-transfer WETH+GLMR → MDA, send→Transact])`.
4. **Moonbeam → Ethereum (atomic fast path)** — the Transact runs as the MDA and calls `BasejumpProxy.bridgeViaWormhole(WETH, ethOut, ETHEREUM_WORMHOLE_ID, IntentRouter, data)`, which (a) TokenBridge-transfers WETH to the landing pool (slow, ~13 min) and (b) publishes the fast VAA → `mrelayer` submits it to Ethereum → `Basejump.completeTransfer` → `BasejumpLanding.transfer(MoonbeamWETH, netAmount, IntentRouter, data)` (remapped to native ETH, paid via `call{value:}`) → `IntentRouter.onBasejumpReceive` → native ETH sent to `depositAddress`, all in one tx (~2 min). Emits `IntentForwarded(intentId, asset, depositAddress, amount)`.
5. **Submit deposit tx (optional speedup)** — `nintent` observes `IntentForwarded`, reads `depositAddress`, and calls `OneClickService.submitDepositTx({ depositAddress, txHash })`. If `nintent` is unavailable, OneClick still picks up the deposit via its own poller.
6. **Quote processing** — the quote service detects the deposit and starts the quoted NEAR Intents flow.
7. **Solver fulfills** — solver delivers the destination asset to the user's destination-chain address.
8. **Slow path settles** — ~13 min after step 4, the Wormhole TokenBridge transfer finalizes on Ethereum; the canonical asset lands in `BasejumpLanding`, replenishing the pool the fast path drew from. Independent of steps 5–7.

## Interface

- `IBasejumpReceiver.sol` (shared) — `onBasejumpReceive(address asset, uint256 amount, bytes calldata data)`. Implemented by any contract that wants atomic post-delivery hooks from Basejump.
- `IIntentRouter.sol` — extends `IBasejumpReceiver` with `sweep(address asset, address to, uint256 amount)`, `setBasejumpLanding`, `setOwner`; events `IntentForwarded(bytes32 intentId, address asset, address depositAddress, uint256 amount)`, `Swept`, `BasejumpLandingUpdated`. `data` MUST decode to `(bytes32 intentId, address depositAddress)`.
- `IIntentEmitter` (Hydration) — `swapAndBridge(uint32 assetIn, uint256 amountIn, uint256 minEthOut, uint256 maxFeeIn, bytes32 intentId, address intentDepositAddress)`; event `BridgeInitiated(bytes32 intentId, address caller, uint32 assetIn, uint256 amountIn, uint256 ethOut, address intentDepositAddress)`; admin `setOwner`/`setRouter`/`setProxy`/`setXcmOperator`/`setXcmParams`.
- `IBasejumpLandingNative` (Ethereum) — `transfer`, `fulfillPending`, `destAssetFor`/`setDestAsset`/`setDestNative`/`isNative`, `NATIVE`, `withdraw`; the authorized bridge is the Ethereum `Basejump`.
- `nintent` exposes no public HTTP API. It is a headless event-driven keeper: chain subscription in, `submitDepositTx` out. Operator-facing logs and metrics only. The UI talks to OneClick directly for both quote acquisition and status polling.

## Fees

Full breakdown and sizing guidance: **[fee.md](fee.md)**. In short, value crosses three charged surfaces:

- **`xcmFee` (GLMR transport)** — bought from `A` on Hydration, bounded by the caller's `maxFeeIn`. Pays the XCM arrival + remote `BuyExecution` (`xcmExecutionFee`). Operator-tunable.
- **`minEthOut` (swap floor)** — caller's slippage bound on the WETH the Hydration swap produces (the amount bridged).
- **`assetFee[WETH]` (Basejump fast-path fee)** — deducted on the Moonbeam proxy (`netAmount = ethOut − assetFee`); owner-configured, must also cover the Wormhole 8-decimal dust so the landing pool stays solvent.

The OneClick quote takes its own spread on the NEAR side (reflected in the quote, not charged on-chain). Sizing target: `value(amountIn) ≳ xcmFee + assetFee[WETH] + oneClick.requiredDeposit`.

## Key Design Decisions

1. **One extrinsic, one route.** Swap + `batch_all` dispatch are atomic on Hydration; the slow TokenBridge transfer and the fast VAA both originate from a single `bridgeViaWormhole` call on Moonbeam, so the fast payout always has a matching replenishment in flight. No separate gating is needed because that call is self-funding (it locks the WETH it bridges).
2. **Any Hydration asset in, ETH out.** The user picks any asset the router can sell; the emitter buys the GLMR fee and swaps the rest to WETH. OneClick's `ETH → *` quote graph is the broadest origin, so the bridged/origin asset is always ETH.
3. **WETH on Hydration/Moonbeam, native ETH at the deposit.** The landing's `destAssetFor` remaps the Moonbeam-WETH source to the `NATIVE` sentinel, so the pool pays native ETH and the router forwards native ETH to the OneClick `depositAddress` (which expects `originAsset = ETH.eth`). The remap lives in the landing because the source contract only knows the source-chain asset address.
4. **Reuse Basejump for the EVM leg, with a small generic extension.** The Wormhole VAA payload carries opaque `bytes data`, and `BasejumpLanding` calls back into recipients implementing `IBasejumpReceiver`. Reusable by future Basejump consumers, not specific to NIR.
5. **Atomic delivery + forward.** `BasejumpLanding.transfer` and `IntentRouter.onBasejumpReceive` execute in the same transaction; if the forward to `depositAddress` reverts, the fast-path completion reverts, while the slow path still settles into the pool.
6. **Caller-set slippage on both swap legs.** `minEthOut` bounds the swap output; `maxFeeIn` bounds the asset spent buying the GLMR fee — so neither a thin `A/WETH` nor `A/GLMR` route can silently extract value.
7. **Quote-scoped origin-chain deposit.** The router forwards to the quote's `depositAddress` on Ethereum, exactly as the OneClick flow expects — no shared NEAR account.
8. **`submitDepositTx` as the NEAR-side continuation.** `nintent` hands OneClick the quoted `depositAddress` and the actual Ethereum tx hash — the canonical signal to continue processing.
9. **Intent ID as local correlation primitive.** Computed by the UI, threaded through `IntentEmitter`, the Basejump `data` payload, and the `IntentForwarded` event. The deposit recipient is `depositAddress`, not `intentId`.
10. **Auth boundary is the VAA + `basejumpLanding`.** `IntentRouter.onBasejumpReceive` is callable only by `BasejumpLanding`; `BasejumpLanding.transfer` only by the authorized Ethereum `Basejump`; `Basejump.completeTransfer` only honors a verified VAA from the configured emitter. There is no externally callable `forward` and no keeper discretion over the destination once the VAA exists.
11. **MDA-stranding is recoverable, not lost.** If the remote Moonbeam leg fails (under-provisioned weight, etc.), WETH/GLMR can strand at the emitter's MDA — but the MDA is the emitter's own sovereign account, recoverable by the owner via a Transact-as-MDA (today through a UUPS upgrade adding a recovery entrypoint).
12. **No on-chain failure handling in V1.** Expired or rejected quotes are handled operationally; on-chain refund logic is deferred. See [refund.md](refund.md).
13. **`sweep` as escape hatch.** Owner-only recovery of stray tokens or native ETH at the router.

## How Existing Contracts Map

| Contract / Component    | Role                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IntentEmitter`         | **New** — on Hydration. Single user entry. Buys the GLMR fee, swaps `A → WETH`, dispatches `batch_all([reserve-transfer WETH+GLMR → MDA, send→Transact bridgeViaWormhole])`. Carries `(intentId, depositAddress)` in the payload.                                                                             |
| `BasejumpProxy`         | On Moonbeam. Called by the emitter's MDA. `bridgeViaWormhole` locks WETH via `TokenBridge.transferTokens` (slow replenishment) **and** publishes the fast-path VAA with `bytes data`. Self-funding; no caller whitelist.                                                                                      |
| Wormhole TokenBridge    | Third-party transport. Moves the locked WETH Moonbeam → Ethereum (~13 min), delivering the canonical asset to the `BasejumpLanding` pool. The slow path that replenishes the fast payout. (8-dec normalization — see fee.md.)                                                                                 |
| `Basejump`              | On Ethereum. Inbound completion. `completeTransfer(vaa)` verifies the VAA, decodes `data`, and calls `BasejumpLandingNative.transfer(..., data)`.                                                                                                                                                             |
| `BasejumpLandingNative` | On Ethereum. Pre-funded pool with a `destAssetFor` source→dest remap (ERC20 or `NATIVE`). For NIR, Moonbeam-WETH → `NATIVE`: pays native ETH to `IntentRouter` via `call{value:}` and invokes `onBasejumpReceive`. Replenished by the slow Wormhole transfer; queues + `fulfillPending` cover liquidity gaps. |
| `IntentRouter`          | **New** — `IBasejumpReceiver` that forwards the delivered asset (native ETH or ERC20) to the OneClick quote's Ethereum `depositAddress`.                                                                                                                                                                      |
| Defuse / OneClick API   | Third-party — returns quote data, quote-specific `depositAddress`, accepts `submitDepositTx`.                                                                                                                                                                                                                 |
| `intents.near`          | Third-party — NEAR Intents settlement layer behind the quote flow.                                                                                                                                                                                                                                            |
| `nintent` agent         | **New** off-chain — headless keeper. Watches `IntentForwarded`, calls `submitDepositTx` as a latency optimization. No HTTP API, no registry. Not in the quote or status paths. OneClick still completes swaps if `nintent` is offline.                                                                        |
