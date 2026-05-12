# Near Intents

## Abstract

Hydration users hold liquid stablecoins (USDC) and want assets on chains Hydration doesn't reach — Bitcoin, Zcash, Solana SPLs, NEAR-native tokens. NEAR Intents already settles swaps across all of these chains through the Defuse / OneClick flow. Near Intents Bridge connects the two: Basejump ships USDC from Hydration to Ethereum, and an adapter forwards the funds into the quote-specific `depositAddress` returned by the OneClick API. After that deposit tx lands, `nintent` calls `submitDepositTx({ depositAddress, txHash })` so the quoted swap can continue and a solver delivers the destination asset (e.g. ZEC) to the user's wallet on the destination chain.

## Overview

The bridge composes two existing systems: **Basejump** (Hydration ↔ EVM, fast-path delivery) and **NEAR Intents / Defuse OneClick** (origin-chain deposits → quoted destination asset, solver settled). A single new on-chain adapter on Ethereum plus an off-chain orchestrator (`nintent`) glue them together. The user obtains a live OneClick quote off-chain; everything after the Basejump initiation is automated.

## V1 Scope

- One new contract: `NearIntentsRouter` on Ethereum (`IBasejumpReceiver`, quote deposit forwarder)
- Source asset: USDC on Hydration
- Bridge hop: Hydration → Moonbeam → Ethereum (existing Basejump path)
- Intent hop: Ethereum USDC → OneClick quote deposit → NEAR Intents → destination asset on destination chain
- Quote model: `OneClickService.getQuote(...)` returns quote details plus a quote-specific `depositAddress` on the origin chain
- Completion model: `OneClickService.submitDepositTx({ depositAddress, txHash })`
- Requires Basejump payload extension: VAA carries opaque `bytes data`, forwarded by `BasejumpLanding` to receiver contracts as a callback
- EVM forward step is **atomic** with Basejump delivery — no keeper involvement, reverts together
- Single `nintent` orchestrator for V1 quote acquisition, deposit submission, monitoring, and manual unwind. Trust is limited to liveness and operations.
- Supported destinations: any NEAR Intents-listed asset/chain pair supported by the quote API (ZEC/Zcash, BTC/Bitcoin, NEAR/NEAR, SPL/Solana, …)
- No on-chain failure handling — happy path only; expired or rejected quotes are unwound off-chain
- No shared NEAR recipient account in the NIR path — the quote's origin-chain `depositAddress` is used directly

## Architecture

Four layers — Hydration entry (UX only), Basejump transport (extended with a `data` payload), `NearIntentsRouter` on Ethereum, and the `nintent` off-chain orchestrator.

### Basejump payload extension (prerequisite)

NearIntentsRouter requires a small, generic extension to Basejump's transport that benefits any future contract recipient:

- `Basejump.bridgeViaWormhole(asset, amount, recipient, bytes data)` — the VAA payload now encodes `(sourceAsset, netAmount, recipient, data)`. `data` is opaque bytes chosen by the caller.
- `BasejumpLanding.transfer(asset, amount, recipient, bytes data)` — after token delivery, if `recipient.code.length > 0` and the recipient implements `IBasejumpReceiver`, BasejumpLanding atomically calls `IBasejumpReceiver(recipient).onBasejumpReceive(asset, amount, data)`. Plain EOAs and non-receiver contracts behave as before (plain token transfer).
- Reverts in `onBasejumpReceive` bubble up and revert the entire `completeTransfer`. The slow TokenBridge path still settles into BasejumpLanding regardless, so liquidity is never stranded.

This extension is what makes the EVM-side forward atomic; everything else in Basejump is unchanged.

### Hydration → Ethereum — Basejump

The Hydration-side leg is plain Basejump. First, `nintent` obtains a OneClick quote for `srcAsset = USDC.eth` and receives a quote-specific `depositAddress` on Ethereum. It stores that quote off-chain and computes a local `intentId` for correlation. The user then XCM-transfers USDC to Moonbeam's `BasejumpProxy` and calls:

`bridgeViaWormhole(USDC, amount, ETHEREUM_WORMHOLE_ID, recipient = NearIntentsRouter, data = abi.encode(intentId, depositAddress))`

From Basejump's perspective the recipient is just another address with attached data; the only special behavior is that the recipient contract knows how to forward funds into the quoted deposit address.

The fast-path VAA settles in ~2s and triggers `BasejumpLanding.transfer(USDC, netAmount, NearIntentsRouter, data)` on Ethereum, which delivers USDC and atomically invokes the router's `onBasejumpReceive`. The slow TokenBridge transfer settles ~13 min later and replenishes BasejumpLanding's pool. See [docs/basejump/spec.md](../basejump/spec.md) for the full transport details.

### Ethereum — `NearIntentsRouter`

A single Ethereum contract that holds no liquidity, only routes. Implements `IBasejumpReceiver`. Funds arrive from BasejumpLanding's `transfer()` payout and are forwarded to the quote-specific `depositAddress` on Ethereum in the same transaction.

**Storage:**

- `usdc` (address) — accepted source asset (V1: USDC)
- `basejumpLanding` (address) — only authorized caller of `onBasejumpReceive`

No replay mapping is needed: a Basejump VAA can only be redeemed once, and `data` is bound to that VAA, so the `(intentId, depositAddress, amount)` tuple cannot reach the router twice.

**`onBasejumpReceive(address asset, uint256 amount, bytes calldata data)`** — invoked by `BasejumpLanding` atomically with token delivery.

1. Requires `msg.sender == basejumpLanding`
2. Requires `asset == usdc`
3. Decodes `(intentId, depositAddress)` from `data`
4. Transfers `amount` USDC to `depositAddress`
5. Emits `IntentForwarded(intentId, depositAddress, amount)`

Any revert in this path (e.g. malformed deposit address, token transfer failure, paused token) bubbles up and reverts the entire `Basejump.completeTransfer`. The user's funds remain claimable via the slow TokenBridge path into BasejumpLanding.

**`sweep(asset, to, amount)`** — owner-only escape hatch for stuck funds (e.g. unexpected token deposits, or USDC sent directly to the router outside the Basejump callback flow).

### Off-chain — `nintent` orchestrator

Long-running TypeScript service, structured like the existing `agents/bjscan` and `agents/broadcaster` packages. Bundles to a single `dist/index.js` via the shared [esbuild.config.mjs](../../esbuild.config.mjs).

**Responsibilities:**

1. **Quote API wrapper** — requests a live Defuse / OneClick quote for `(originAsset = USDC.eth, amount, destinationAsset, recipient, deadline, ...)`. Returns quote details, expiry, and `quote.quote.depositAddress` (plus optional `depositMemo` when present).
2. **Intent registry** — stores accepted quotes keyed by local `intentId`. Each record includes `quoteId`, `depositAddress`, optional `depositMemo`, quoted output, deadline, and destination details.
3. **Forward watcher** — subscribes to `IntentForwarded` events on `NearIntentsRouter`. This is the signal that the EVM-side forward has completed atomically with Basejump delivery; the watcher also captures the Ethereum tx hash from the event.
4. **Deposit submitter** — calls `OneClickService.submitDepositTx({ depositAddress, txHash })` using the quote's `depositAddress` and the Ethereum tx hash from step 3. This lets the service detect the deposit faster and start processing sooner.
5. **Settlement monitor** — watches quote / swap status through the quote API until fulfillment or failure, then reports completion to the user.
6. **Failure path (manual for V1)** — if the quote expires before the deposit can be processed, or the quoted deposit is rejected, the operator reverses the position: bridges USDC back from Ethereum to Hydration via Basejump and returns it to the user.

Note: the orchestrator has no role in the EVM-side forward — that step is atomic with Basejump delivery. Its responsibilities are quote acquisition, registration, `submitDepositTx`, monitoring, and the off-chain failure path.

**Intent ID** = local correlation hash generated by `nintent`, for example:

`keccak256(abi.encode(quoteId, depositAddress, srcAmount, destAsset, destRecipient, deadline, nonce))`

The same hash is used as:

- the first field in Basejump `data`, carried end-to-end into `NearIntentsRouter.onBasejumpReceive`
- the lookup key in `nintent`'s registry
- the memo / correlation field for logs and status checks on our side

### NEAR side — third-party

Near Intents Bridge does not deploy anything on NEAR. It relies on the existing quote / deposit pipeline:

| Component                      | Role                                                                 |
| ----------------------------- | -------------------------------------------------------------------- |
| Defuse / OneClick quote API   | Returns quote details, `depositAddress`, and accepts `submitDepositTx` |
| `intents.near`                | Solver settlement and destination execution                          |
| Solvers                       | Provide destination asset (ZEC, BTC, …) on destination chain         |

## Flow

See [schema.md](schema.md) for full chain-hop diagrams.

End-to-end happy path:

1. **Quote** — `nintent` requests a live quote for `USDC.hydration → destination asset`. The quote API returns quoted output, expiry, and `quote.quote.depositAddress` on Ethereum.
2. **Accept** — user accepts the live quote off-chain. `nintent` stores the quote, validates that `depositAddress` is an Ethereum address, and computes a local `intentId`.
3. **Bridge** — user initiates Basejump on Hydration with `recipient = NearIntentsRouter` and `data = abi.encode(intentId, depositAddress)`.
4. **Fast-path delivery + forward (atomic)** — Wormhole fast VAA → `Basejump.completeTransfer` on Ethereum → `BasejumpLanding.transfer(USDC, netAmount, NearIntentsRouter, data)` → `NearIntentsRouter.onBasejumpReceive` → USDC transfer to `depositAddress`, all in one transaction (~2 min). Emits `IntentForwarded(intentId, depositAddress, amount)`.
5. **Submit deposit tx** — `nintent` calls `OneClickService.submitDepositTx({ depositAddress, txHash })`, using the router tx hash from step 4.
6. **Quote processing** — the quote service detects the deposit and starts the quoted NEAR Intents flow.
7. **Solver fulfills** — solver delivers the destination asset to the user's destination-chain address.
8. **Basejump slow settles** — ~13 min after step 3, TokenBridge transfer finalizes and replenishes `BasejumpLanding`'s pool on Ethereum. Independent of steps 4–7.

## Interface

- `IBasejumpReceiver.sol` (shared) — `onBasejumpReceive(address asset, uint256 amount, bytes calldata data)`. Implemented by any contract that wants atomic post-delivery hooks from Basejump.
- `INearIntentsRouter.sol` — extends `IBasejumpReceiver` with `sweep(address asset, address to, uint256 amount)`, event `IntentForwarded`. `data` MUST decode to `(bytes32 intentId, address depositAddress)`.
- `nintent` HTTP API — `POST /quote`, `POST /intent`, `GET /intent/:id` (status). To be documented inside the `agents/nintent/` package alongside `broadcaster` and `bjscan`.

## Key Design Decisions

1. **Reuse Basejump for the EVM leg, with a small generic extension.** No new transport, no parallel VAA scheme. The only change to Basejump is an opaque `bytes data` field on the VAA payload and a post-delivery callback into recipients that implement `IBasejumpReceiver`. This is reusable by future Basejump consumers, not specific to NIR.
2. **Atomic delivery + forward.** `BasejumpLanding.transfer` and `NearIntentsRouter.onBasejumpReceive` execute in the same transaction. If the deposit transfer to `depositAddress` reverts, the entire fast-path completion reverts; the slow TokenBridge path still settles into `BasejumpLanding`, so user funds are never stranded at the router.
3. **Quote-scoped origin-chain deposit.** The router does not deposit into a shared NEAR account. It forwards USDC to the quote's origin-chain `depositAddress` on Ethereum, exactly as the OneClick flow expects.
4. **`submitDepositTx` as the NEAR-side continuation.** `nintent` does not manually reconstruct a NEAR settlement step. It hands Defuse / OneClick the quoted `depositAddress` and the actual Ethereum tx hash, which is the canonical signal to continue processing the quote.
5. **Intent ID as local correlation primitive.** `intentId` is our join key across quote registration, Basejump `data`, router events, and status monitoring. The actual deposit recipient is `depositAddress`, not `intentId`.
6. **Auth boundary is `basejumpLanding`, not an orchestrator.** `onBasejumpReceive` is callable only by the authorized `BasejumpLanding`. There is no externally callable `forward` and no keeper discretion over the destination deposit address once the VAA is created.
7. **No on-chain failure handling in V1.** Expired or rejected quotes are handled operationally. On-chain refund logic is deferred to V2.
8. **`sweep` as escape hatch.** Slow-settlement USDC arrives at `BasejumpLanding`, not at the router — but operator error or unexpected token deposits should still be recoverable. `sweep` is owner-only.

## How Existing Contracts Map

| Contract / Component | Role                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BasejumpProxy`      | On Moonbeam. Hydration's outbound proxy. `bridgeViaWormhole` extended with `bytes data` carrying `(intentId, depositAddress)`                         |
| `Basejump`           | On Ethereum. Inbound completion. `completeTransfer(vaa)` decodes `data` from the VAA and dispatches to `BasejumpLanding.transfer(..., data)`         |
| `BasejumpLanding`    | On Ethereum. Pre-funded USDC pool; pays out to `NearIntentsRouter` and atomically invokes its `onBasejumpReceive(asset, amount, data)` callback      |
| `NearIntentsRouter`  | New — `IBasejumpReceiver` that forwards arriving USDC to the OneClick quote's Ethereum `depositAddress`                                             |
| Defuse / OneClick API | Third-party — returns quote data, quote-specific `depositAddress`, and accepts `submitDepositTx`                                                   |
| `intents.near`       | Third-party — NEAR Intents settlement layer behind the quote flow                                                                                   |
| `nintent` agent      | New off-chain — quote API wrapper, registry, deposit submitter, settlement watch                                                                    |
