# Near Intents

## Abstract

Hydration users hold ETH and want assets on chains Hydration doesn't reach — Bitcoin, Zcash, Solana SPLs, NEAR-native tokens. NEAR Intents already settles swaps across all of these chains through the Defuse / OneClick flow. Near Intents Bridge connects the two: a Hydration-initiated dual-transport ships ETH to Ethereum's `BasejumpLanding` pool and atomically triggers a fast-path payout into the quote-specific `depositAddress` returned by the OneClick API. After that deposit tx lands, `nintent` calls `submitDepositTx({ depositAddress, txHash })` so the quoted swap can continue and a solver delivers the destination asset (e.g. ZEC) to the user's wallet on the destination chain.

## Overview

The bridge composes two existing systems: **Basejump** (fast-path delivery against a pre-funded EVM pool) and **NEAR Intents / Defuse OneClick** (origin-chain deposits → quoted destination asset, solver settled). On Hydration, a new `BasejumpHub` contract atomically fires two transports in a single extrinsic: a Snowbridge transfer of the user's WETH-on-Hydration that replenishes `BasejumpLanding` with **native ETH** on Ethereum (slow, ~30 min — Snowbridge handles the WETH→ETH conversion at the bridge boundary) and an MRL/XCM call to Moonbeam's `BasejumpProxy` that triggers the fast-path Wormhole VAA (~2 min). On Ethereum, a single `NearIntentsRouter` adapter forwards native ETH to the OneClick `depositAddress`. The off-chain orchestrator `nintent` only nudges OneClick's deposit detector. The user obtains a live OneClick quote off-chain for `originAsset = ETH.eth`; everything after `BasejumpHub.bridgeAndForward(...)` is automated.

## V1 Scope

- Two new contracts:
  - `BasejumpHub` on Hydration — atomic dual-transport initiator (Snowbridge + MRL)
  - `NearIntentsRouter` on Ethereum (`IBasejumpReceiver`, forwards native ETH to quote deposit address)
- Source asset: **ETH** end-to-end (held as WETH on Hydration; native ETH everywhere on Ethereum — Snowbridge unwraps at the bridge boundary)
- Asset transport: **Snowbridge** from Hydration → Ethereum, depositing native ETH into `BasejumpLanding`'s pool (~30 min)
- Trigger transport: MRL/XCM Hydration → Moonbeam → `BasejumpProxy` → Wormhole VAA → Ethereum (~2 min for fast-path payout)
- Auth boundary on Moonbeam: `BasejumpProxy.bridgeViaWormhole` is whitelist-gated to `BasejumpHub`'s Moonbeam MDA — no other caller can trigger a fast-path payout
- Intent hop: Ethereum ETH → OneClick quote deposit → NEAR Intents → destination asset on destination chain
- Quote model: `OneClickService.getQuote(originAsset = ETH.eth, ...)` returns quote details plus a quote-specific `depositAddress` on Ethereum
- Completion model: OneClick auto-detects deposits on `depositAddress` and starts processing on receipt; `OneClickService.submitDepositTx({ depositAddress, txHash })` is an optional latency optimization (~poller interval → ~seconds)
- Requires Basejump payload extension: VAA carries opaque `bytes data`, forwarded by `BasejumpLanding` to receiver contracts as a callback
- EVM forward step is **atomic** with Basejump fast-path delivery — no keeper involvement, reverts together
- Hydration-side dual-transport is **atomic** in one extrinsic — Snowbridge transfer and MRL trigger either both fire or neither does
- Single `nintent` headless keeper: watches `IntentForwarded` events on `NearIntentsRouter` and calls `OneClick.submitDepositTx({ depositAddress, txHash })` as a latency optimization. OneClick auto-detects deposits without it; nintent just makes detection ~seconds instead of one poller interval. No HTTP API, no quote-path involvement, no per-quote registry. Quote acquisition is UI ↔ OneClick direct. Failure unwind is operator-driven outside the agent.
- Supported destinations: any NEAR Intents-listed asset/chain pair supported by the quote API (ZEC/Zcash, BTC/Bitcoin, NEAR/NEAR, SPL/Solana, …)
- No on-chain failure handling — happy path only; expired or rejected quotes are unwound off-chain (see [refund.md](refund.md))
- No shared NEAR recipient account in the NIR path — the quote's origin-chain `depositAddress` is used directly

## Architecture

Five layers — Hydration entry (`BasejumpHub`), Snowbridge asset transport (slow, replenishes the pool), MRL trigger transport (fast, via Moonbeam `BasejumpProxy` and Wormhole), Ethereum delivery (`Basejump` → `BasejumpLanding` → `NearIntentsRouter`), and the `nintent` off-chain orchestrator.

### Hydration — `BasejumpHub`

The entry point on Hydration. Holds no liquidity. Single responsibility: fire two transports together so the fast-path payout always has a matching replenishment in flight.

**Storage / config:**

- `snowbridgeGateway` — handle/address used to initiate the Snowbridge transfer
- `moonbeamBasejumpProxy` — address (H160) of `BasejumpProxy` on Moonbeam
- `basejumpLanding` — Ethereum address that receives the Snowbridge-bridged native ETH (the destination of the slow leg)
- `wethHydration` — Hydration-side asset id for WETH (the form ETH takes on Hydration; Snowbridge unwraps to native ETH on the Ethereum side)

**`bridgeAndForward(uint256 ethAmount, bytes32 intentId, address depositAddress)`** — single user entry. In one extrinsic, atomically:

1. Transfers `ethAmount` of WETH from the caller (Hydration-side balance) into `BasejumpHub`'s control.
2. Initiates a **Snowbridge transfer** of `ethAmount` to `basejumpLanding` on Ethereum. Snowbridge converts WETH (Polkadot side) → native ETH (Ethereum side) as part of the transfer.
3. Dispatches an **MRL/XCM message** to Moonbeam invoking `BasejumpProxy.bridgeViaWormhole(ETH, ethAmount, ETHEREUM_WORMHOLE_ID, NearIntentsRouter, data = abi.encode(intentId, depositAddress))`. The MRL leg carries no liquidity — its sole purpose is the remote call. `ETH` here is the agreed sentinel/representation for native ETH in the Basejump VAA payload.
4. Emits `BasejumpInitiated(intentId, caller, ethAmount, depositAddress)`.

If any step fails the whole extrinsic reverts — no partial state, no leaked transports.

The Hydration-side caller is normally the user's account (EOA or proxy). `BasejumpHub` is the only contract authorized to trigger a fast-path payout because `BasejumpProxy` on Moonbeam will only accept calls from `BasejumpHub`'s MDA (see below). This is what binds the trigger to a real replenishment.

### Snowbridge transport (slow leg, asset)

Spec'd abstractly — the slow leg is a Snowbridge transfer that takes WETH on Hydration and delivers **native ETH** to `BasejumpLanding` on Ethereum. The WETH→ETH conversion is handled by Snowbridge at the bridge boundary; no on-chain unwrap happens on the Ethereum side of this protocol. Implementation may route Hydration → AssetHub → BridgeHub → Ethereum, or take a more direct path; the protocol guarantee that matters here is "native ETH will arrive at `basejumpLanding` in roughly 30 minutes." That arrival replenishes the pool that the fast-path payout drew from.

Snowbridge is the **only** source of replenishment in V1 — there is no Wormhole TokenBridge slow path. The `BasejumpProxy` on Moonbeam no longer locks or transfers tokens.

### Basejump payload extension (prerequisite, unchanged from previous design)

`NearIntentsRouter` requires a small, generic extension to Basejump's transport that benefits any future contract recipient:

- `BasejumpProxy.bridgeViaWormhole(asset, amount, recipient, bytes data)` — the VAA payload now encodes `(sourceAsset, netAmount, recipient, data)`. `data` is opaque bytes chosen by the caller.
- `BasejumpLanding.transfer(asset, amount, recipient, bytes data)` — after token delivery, if `recipient.code.length > 0` and the recipient implements `IBasejumpReceiver`, `BasejumpLanding` atomically calls `IBasejumpReceiver(recipient).onBasejumpReceive(asset, amount, data)`. Plain EOAs and non-receiver contracts behave as before (plain token transfer).
- Reverts in `onBasejumpReceive` bubble up and revert the entire `Basejump.completeTransfer`. The Snowbridge slow leg still settles into `BasejumpLanding` regardless, so liquidity is never stranded.

This extension is what makes the EVM-side forward atomic; everything else in Basejump (other than the auth and the removal of the Moonbeam-side token lock — see below) is unchanged.

### Moonbeam — `BasejumpProxy` (changes)

Two changes from the prior design:

1. **No token transport.** `BasejumpProxy.bridgeViaWormhole` no longer calls `TokenBridge.transferTokens`. The slow asset path lives in Snowbridge, not Wormhole. `BasejumpProxy` only publishes the fast-path Wormhole VAA via `wormhole.publishMessage`.
2. **Whitelisted caller.** `BasejumpProxy.bridgeViaWormhole` requires `msg.sender == basejumpHubMDA`, where `basejumpHubMDA` is the Moonbeam-side Multilocation Derived Account of the Hydration `BasejumpHub` contract. Without this check, anyone could trigger a fast-path payout from `BasejumpLanding` without a matching Snowbridge replenishment, draining the pool. With it, the only way to produce a valid fast-path VAA is to have gone through `BasejumpHub.bridgeAndForward(...)` on Hydration, which atomically fired the Snowbridge leg.

`basejumpHubMDA` is configured on `BasejumpProxy` at deploy time and may be rotated by the owner during upgrades (e.g. if `BasejumpHub` is redeployed on Hydration).

### Ethereum — `Basejump` and `BasejumpLanding` (changes)

- `BasejumpLanding`'s pre-funded pool is **native ETH**, not USDC and not WETH. The pool is replenished only by Snowbridge transfers from Hydration, which arrive as native ETH.
- `Basejump.completeTransfer(vaa)` and `BasejumpLanding.transfer(...)` decode the `data` payload from the VAA, deliver native ETH to the recipient (via `call{value: amount}("")`), and invoke `onBasejumpReceive` if the recipient implements `IBasejumpReceiver`. The `asset` field in the VAA payload is the ETH sentinel; `BasejumpLanding` interprets this as a native ETH payout rather than an ERC20 transfer.

### Ethereum — `NearIntentsRouter`

A single Ethereum contract that holds no liquidity, only routes. Implements `IBasejumpReceiver`. Native ETH arrives from `BasejumpLanding`'s payout (`call{value:}`); the router forwards it to the quote-specific `depositAddress` in the same transaction.

**Storage:**

- `basejumpLanding` (address) — only authorized caller of `onBasejumpReceive`

No replay mapping is needed: a Basejump VAA can only be redeemed once, and `data` is bound to that VAA, so the `(intentId, depositAddress, amount)` tuple cannot reach the router twice.

**`onBasejumpReceive(address asset, uint256 amount, bytes calldata data)`** — invoked by `BasejumpLanding` atomically with native ETH delivery. The function is `payable`; `msg.value == amount`.

1. Requires `msg.sender == basejumpLanding`
2. Requires `asset` equals the ETH sentinel
3. Requires `msg.value == amount`
4. Decodes `(intentId, depositAddress)` from `data`
5. Sends `amount` native ETH to `depositAddress` via `call{value: amount}("")`
6. Emits `IntentForwarded(intentId, depositAddress, amount)`

Any revert in this path (e.g. malformed deposit address, payable rejection at the deposit address) bubbles up and reverts the entire `Basejump.completeTransfer`. The user's funds remain claimable via the Snowbridge slow path, which lands native ETH directly in `BasejumpLanding`.

**`sweep(asset, to, amount)`** — owner-only escape hatch for stuck funds (e.g. unexpected token deposits, or ETH sent directly to the router outside the Basejump callback flow).

### Off-chain — `nintent` orchestrator

Long-running TypeScript service, structured like the existing `agents/bjscan` and `agents/broadcaster` packages. Bundles to a single `dist/index.js` via the shared [esbuild.config.mjs](../../esbuild.config.mjs).

**Responsibilities (the whole list):**

1. **Forward watcher** — subscribes to `IntentForwarded(intentId, depositAddress, amount)` events on `NearIntentsRouter`. Captures `depositAddress` and the Ethereum tx hash from the event; no prior registration is needed.
2. **Deposit submitter** — calls `OneClickService.submitDepositTx({ depositAddress, txHash })` for each observed event.

`submitDepositTx` is **not required for the swap to complete**. OneClick polls the origin chain for the `depositAddress` it issued and starts processing on receipt automatically. The agent exists only to compress detection latency from a poller interval (potentially tens of seconds) to ~seconds by pushing the tx hash to OneClick as soon as the on-chain event fires.

That's it. `nintent` exposes no HTTP API and stores no per-quote registry. The UI talks to OneClick directly for quote acquisition and status polling. The orchestrator has no role in quote acquisition and no role in the EVM-side forward (atomic with Basejump delivery). If the agent is down, swaps still complete — just slower.

Operator-driven failure unwind (expired quote, rejected deposit) is a manual process handled outside the agent in V1 — no automated logic lives in `nintent` for it. See [refund.md](refund.md).

**Intent ID** = local correlation hash computed by the UI from the accepted quote, for example:

`keccak256(abi.encode(quoteId, depositAddress, srcAmount, destAsset, destRecipient, deadline, nonce))`

The same hash is used as:

- the first field in `BasejumpHub.bridgeAndForward(...)` and in the Basejump `data` payload, carried end-to-end into `NearIntentsRouter.onBasejumpReceive`
- the first field of the `IntentForwarded` event, observable on-chain
- the correlation key in logs and analytics (joining Hydration `BasejumpInitiated`, Ethereum `IntentForwarded`, and OneClick status records off-chain)

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
2. **Accept** — user reviews and accepts the live quote in the UI. The UI computes the local `intentId` from the accepted parameters. `nintent` is not involved.
3. **Hydration atomic dispatch** — user calls `BasejumpHub.bridgeAndForward(ethAmount, intentId, depositAddress)` on Hydration (paying with WETH). In one extrinsic, `BasejumpHub` fires:
   - **Snowbridge leg** — transfer from Hydration to `BasejumpLanding` on Ethereum (~30 min finality). The bridge unwraps WETH to native ETH at its boundary; native ETH lands at `BasejumpLanding`.
   - **MRL leg** — XCM message to Moonbeam that invokes `BasejumpProxy.bridgeViaWormhole(ETH, ethAmount, ETHEREUM_WORMHOLE_ID, NearIntentsRouter, data = abi.encode(intentId, depositAddress))`. The MRL leg carries no liquidity; `BasejumpProxy` accepts the call only because `msg.sender` is `BasejumpHub`'s MDA.
4. **Fast-path VAA + delivery + forward (atomic)** — Moonbeam `BasejumpProxy` publishes Wormhole VAA → `mrelayer` picks up the instant VAA (~2s finality) and submits to Ethereum → `Basejump.completeTransfer(vaa)` → `BasejumpLanding.transfer(ETH, ethAmount, NearIntentsRouter, data)` (native ETH payout via `call{value:}`) → `NearIntentsRouter.onBasejumpReceive` → native ETH sent to `depositAddress`, all in one transaction (~2 min end-to-end). Emits `IntentForwarded(intentId, depositAddress, amount)`.
5. **Submit deposit tx (optional speedup)** — `nintent` observes `IntentForwarded`, reads `depositAddress` from the event, and calls `OneClickService.submitDepositTx({ depositAddress, txHash })` with the router tx hash from step 4. If `nintent` is unavailable, OneClick still picks up the deposit via its own poller.
6. **Quote processing** — the quote service detects the deposit and starts the quoted NEAR Intents flow.
7. **Solver fulfills** — solver delivers the destination asset to the user's destination-chain address.
8. **Snowbridge slow settles** — ~30 min after step 3, the Snowbridge transfer finalizes on Ethereum; native ETH lands in `BasejumpLanding`, replenishing the pool. Independent of steps 4–7.

## Interface

- `IBasejumpReceiver.sol` (shared) — `onBasejumpReceive(address asset, uint256 amount, bytes calldata data)`. Implemented by any contract that wants atomic post-delivery hooks from Basejump.
- `INearIntentsRouter.sol` — extends `IBasejumpReceiver` with `sweep(address asset, address to, uint256 amount)`, event `IntentForwarded(bytes32 intentId, address depositAddress, uint256 amount)`. `data` MUST decode to `(bytes32 intentId, address depositAddress)`.
- `IBasejumpHub` (Hydration) — `bridgeAndForward(uint256 ethAmount, bytes32 intentId, address depositAddress)`, event `BasejumpInitiated(bytes32 intentId, address caller, uint256 ethAmount, address depositAddress)`.
- `BasejumpProxy` (Moonbeam) — auth: `msg.sender == basejumpHubMDA`. Setter: owner-only `setBasejumpHubMDA(address)`.
- `nintent` exposes no public HTTP API. It is a headless event-driven keeper: chain subscription in, `submitDepositTx` out. Operator-facing logs and metrics only. The UI talks to OneClick directly for both quote acquisition and status polling.

## Fees — TBD

The new design introduces two fees that need to be accounted for:

- **Snowbridge transfer fee** — charged on the slow leg (Hydration → Ethereum WETH transfer). Typically denominated in DOT or a similar bridge-hub currency.
- **Wormhole VAA fee** — charged on the MRL leg's Wormhole publish on Moonbeam. Typically denominated in GLMR.

These need to be specified before contract implementation. Below are candidate approaches; final choice deferred.

### Suggested approaches

1. **Net-in for Snowbridge, protocol-subsidized Wormhole (recommended).**
   - User specifies `ethAmount` as the gross WETH input.
   - `BasejumpHub` deducts the Snowbridge fee equivalent (converted to WETH at a current rate or routed through a fee swap) before sending the slow leg, and passes the **net** amount to the MRL leg so the fast-path VAA payout matches what Snowbridge will deliver.
   - The Wormhole publish fee on Moonbeam is paid out of a GLMR balance held by `BasejumpProxy` and topped up by the protocol — a small, predictable operational cost.
   - UX: single ETH amount in, transparent fee slippage like any bridge; no second token needed.
   - Pool accounting stays balanced: the fast payout and the Snowbridge replenishment carry the same net WETH amount.

2. **Two-token fees, user-paid in full.**
   - User pays Snowbridge fee in DOT (or whatever Snowbridge accepts) and Wormhole fee in GLMR, both separately from `ethAmount`.
   - `BasejumpHub` collects DOT alongside WETH; the MRL leg's executor pays GLMR on Moonbeam.
   - UX: clean accounting, ugly UX (user needs three currencies on Hydration).
   - Pool accounting stays balanced trivially because both legs carry the full `ethAmount`.

3. **Fully protocol-subsidized.**
   - Hydration treasury (or a `BasejumpHub`-owned float) absorbs both fees.
   - User pays only `ethAmount` in WETH; both legs carry the full amount.
   - UX: simplest possible.
   - Pool accounting stays balanced but the protocol bleeds DOT + GLMR per swap — likely unsustainable at scale, viable only as an early-launch subsidy.

4. **Net-in for both fees, converted to WETH equivalents.**
   - User specifies gross `ethAmount`. `BasejumpHub` quotes both fee amounts in WETH terms (using on-chain price feeds or a fee margin), deducts both, and passes net WETH to both legs.
   - Fee currency conversion happens at the protocol boundary (e.g., a separate WETH→DOT swap on Hydration, WETH→GLMR via MRL).
   - UX: single ETH amount, transparent slippage.
   - Pool accounting balanced.
   - Complexity: requires a fee-conversion mechanism; adds price-feed dependency.

**Recommendation (1)** keeps the pool balanced, gives the user a one-token UX, and limits ongoing protocol cost to a small GLMR float. The Wormhole VAA fee is small and predictable enough that subsidizing it is reasonable; the Snowbridge fee is large enough that the user should see it.

## Key Design Decisions

1. **Two transports from Hydration, fired atomically.** Snowbridge moves the asset (slow, ~30 min); MRL moves the trigger (fast, ~2 min). `BasejumpHub` is the only place that can issue them paired. This is the protocol's atomicity boundary — a malicious actor cannot trigger the fast-path payout without also having committed to the Snowbridge replenishment.
2. **Whitelisted MDA on `BasejumpProxy`.** Because `BasejumpProxy` no longer locks tokens (Snowbridge owns the asset path), its fast-path publish would otherwise be free to call. Restricting `msg.sender` to `BasejumpHub`'s Moonbeam MDA closes the loop: every fast-path VAA traces back to a single atomic Hydration extrinsic.
3. **ETH chosen as the universal source asset.** OneClick's `ETH → *` quote graph is the broadest (every chain/asset pair backed by NEAR Intents accepts ETH as origin). Snowbridge supports WETH natively. ETH on Hydration is plentiful via existing bridges. USDC has none of these advantages.
4. **WETH on Hydration, native ETH everywhere on Ethereum.** Snowbridge handles the WETH→ETH conversion at the bridge boundary, so `BasejumpLanding` holds and pays out native ETH and the router forwards native ETH directly. No on-chain unwrap step is needed in the Basejump payout path; OneClick's `originAsset = ETH.eth` quotes receive native ETH at the `depositAddress` as expected.
5. **Reuse Basejump for the EVM leg, with a small generic extension.** The Wormhole VAA payload carries opaque `bytes data`, and `BasejumpLanding` callbacks into recipients that implement `IBasejumpReceiver`. This is reusable by future Basejump consumers, not specific to NIR.
6. **Atomic delivery + forward.** `BasejumpLanding.transfer` and `NearIntentsRouter.onBasejumpReceive` execute in the same transaction. If the deposit transfer to `depositAddress` reverts, the entire fast-path completion reverts; the Snowbridge slow path still settles into `BasejumpLanding`, so user funds are never stranded at the router.
7. **Quote-scoped origin-chain deposit.** The router does not deposit into a shared NEAR account. It forwards ETH to the quote's origin-chain `depositAddress` on Ethereum, exactly as the OneClick flow expects.
8. **`submitDepositTx` as the NEAR-side continuation.** `nintent` does not manually reconstruct a NEAR settlement step. It hands Defuse / OneClick the quoted `depositAddress` and the actual Ethereum tx hash, which is the canonical signal to continue processing the quote.
9. **Intent ID as local correlation primitive.** `intentId` is computed by the UI and threaded through `BasejumpHub`, Basejump `data`, the `IntentForwarded` event, and (optionally) operator logs. The actual deposit recipient is `depositAddress`, not `intentId`.
10. **Auth boundaries are `basejumpHubMDA` (Moonbeam) and `basejumpLanding` (Ethereum), not orchestrators.** `BasejumpProxy.bridgeViaWormhole` is callable only by `BasejumpHub`'s MDA. `NearIntentsRouter.onBasejumpReceive` is callable only by `BasejumpLanding`. There is no externally callable `forward` and no keeper discretion over the destination deposit address once the VAA is created.
11. **No on-chain failure handling in V1.** Expired or rejected quotes are handled operationally. On-chain refund logic is deferred to V2. See [refund.md](refund.md).
12. **`sweep` as escape hatch.** Snowbridge replenishment arrives at `BasejumpLanding`, not at the router — but operator error or unexpected token deposits should still be recoverable. `sweep` is owner-only.

## How Existing Contracts Map

| Contract / Component  | Role                                                                                                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BasejumpHub`         | **New** — on Hydration. Single entry point for users. Atomically fires Snowbridge leg (WETH on Hydration → native ETH at `BasejumpLanding`) and MRL leg (XCM → Moonbeam → `BasejumpProxy`). Carries `(intentId, depositAddress)` in the MRL payload.                                 |
| `BasejumpProxy`       | On Moonbeam. Auth: `msg.sender == basejumpHubMDA`. No longer calls `TokenBridge.transferTokens` — only publishes the fast-path Wormhole VAA. `bridgeViaWormhole` carries `bytes data = (intentId, depositAddress)`.                                                                  |
| Snowbridge            | Third-party transport. Moves user WETH on Hydration to native ETH at `BasejumpLanding` on Ethereum (unwraps at the bridge boundary). Replaces the Wormhole TokenBridge slow path entirely in this design.                                                                            |
| `Basejump`            | On Ethereum. Inbound completion. `completeTransfer(vaa)` decodes `data` from the VAA and dispatches to `BasejumpLanding.transfer(..., data)`. Unchanged in shape; now carries the ETH sentinel as `asset`.                                                                          |
| `BasejumpLanding`     | On Ethereum. Pre-funded **native ETH** pool. Pays out to `NearIntentsRouter` via `call{value:}` and atomically invokes its `onBasejumpReceive(asset, amount, data)` callback. Replenished by Snowbridge, not Wormhole.                                                              |
| `NearIntentsRouter`   | **New** — `IBasejumpReceiver` that forwards incoming native ETH to the OneClick quote's Ethereum `depositAddress`. No unwrap step.                                                                                                                                                  |
| Defuse / OneClick API | Third-party — returns quote data, quote-specific `depositAddress`, accepts `submitDepositTx`.                                                                                                                                                                                       |
| `intents.near`        | Third-party — NEAR Intents settlement layer behind the quote flow.                                                                                                                                                                                                                  |
| `nintent` agent       | **New** off-chain — headless keeper. Watches `IntentForwarded`, calls `submitDepositTx` as a latency optimization. No HTTP API, no registry. Not in the quote or status paths. OneClick still completes swaps if `nintent` is offline.                                              |
