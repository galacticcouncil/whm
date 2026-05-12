# Near Intents

## Abstract

Hydration users hold liquid stablecoins (USDC) and want assets on chains Hydration doesn't reach — Bitcoin, Zcash, Solana SPLs, NEAR-native tokens. NEAR Intents is a solver network that already settles swaps across all of these chains, but its on-ramps are EVM and NEAR. Near Intents Bridge connects the two: Basejump ships USDC from Hydration to Ethereum, and an adapter forwards the funds into NEAR Intents with a user-signed quote so a solver delivers the destination asset (e.g. ZEC) to the user's wallet on the destination chain (e.g. Zcash).

## Overview

The bridge composes two existing systems: **Basejump** (Hydration ↔ EVM, fast-path delivery) and **NEAR Intents** (EVM/NEAR → any supported chain, solver settled). A single new on-chain adapter on Ethereum plus an off-chain orchestrator (`nintent`) glue them together. The user signs the NEAR intent quote off-chain; everything else is automated.

## V1 Scope

- One new contract: `NearIntentsRouter` on Ethereum (`IBasejumpReceiver`, OmniBridge depositor)
- Source asset: USDC on Hydration
- Bridge hop: Hydration → Moonbeam → Ethereum (existing Basejump path)
- Intent hop: Ethereum USDC → NEAR Intents → destination asset on destination chain
- Requires Basejump payload extension: VAA carries an opaque `bytes data` field, forwarded by `BasejumpLanding` to receiver contracts as a callback
- EVM forward step is **atomic** with Basejump delivery — no keeper involvement, reverts together
- Trusted single `nintent` orchestrator for NEAR-side submission (mirrors V1 Basejump relayer trust model)
- Supported destinations: any NEAR Intents-listed asset/chain pair (ZEC/Zcash, BTC/Bitcoin, NEAR/NEAR, SPL/Solana, …)
- No on-chain failure handling — happy path only; expired or unfulfilled intents are unwound off-chain
- No on-chain custody of NEAR account — orchestrator holds the service NEAR account that signs quotes

## Architecture

Four layers — Hydration entry (UX only), Basejump transport (extended with a `data` payload), `NearIntentsRouter` on Ethereum, and the `nintent` off-chain orchestrator (NEAR-side only).

### Basejump payload extension (prerequisite)

NearIntentsRouter requires a small, generic extension to Basejump's transport that benefits any future contract recipient:

- `Basejump.bridgeViaWormhole(asset, amount, recipient, bytes data)` — the VAA payload now encodes `(sourceAsset, netAmount, recipient, data)`. `data` is opaque bytes chosen by the caller.
- `BasejumpLanding.transfer(asset, amount, recipient, bytes data)` — after token delivery, if `recipient.code.length > 0` and the recipient implements `IBasejumpReceiver`, BasejumpLanding atomically calls `IBasejumpReceiver(recipient).onBasejumpReceive(asset, amount, data)`. Plain EOAs and non-receiver contracts behave as before (plain token transfer).
- Reverts in `onBasejumpReceive` bubble up and revert the entire `completeTransfer`. The slow TokenBridge path still settles into BasejumpLanding regardless, so liquidity is never stranded.

This extension is what makes the EVM-side forward atomic; everything else in Basejump is unchanged.

### Hydration → Ethereum — Basejump

The Hydration-side leg is plain Basejump. The user XCM-transfers USDC to Moonbeam's `BasejumpProxy` and calls `bridgeViaWormhole(USDC, amount, ETHEREUM_WORMHOLE_ID, recipient = NearIntentsRouter, data = intentId)`. From Basejump's perspective the recipient is just another address with attached data; the only thing special about it is that the recipient happens to be a contract that knows how to forward funds into NEAR Intents.

The fast-path VAA settles in ~2s and triggers `BasejumpLanding.transfer(USDC, netAmount, NearIntentsRouter, intentId)` on Ethereum, which delivers USDC and atomically invokes the router's `onBasejumpReceive`. The slow TokenBridge transfer settles ~13 min later and replenishes BasejumpLanding's pool. See [docs/basejump/spec.md](../basejump/spec.md) for the full transport details.

### Ethereum — `NearIntentsRouter`

A single Ethereum contract that holds no liquidity, only routes. Implements `IBasejumpReceiver`. Funds arrive from BasejumpLanding's `transfer()` payout and are forwarded into OmniBridge in the same transaction.

**Storage:**

- `omniBridge` (address) — OmniBridge ERC20 locker on Ethereum
- `usdc` (address) — accepted source asset (V1: USDC)
- `serviceAccount` (string) — NEAR account that receives the deposit credit on `intents.near` (held by the `nintent` orchestrator)
- `basejumpLanding` (address) — only authorized caller of `onBasejumpReceive`

No `forwarded` replay mapping is needed: a Basejump VAA can only be redeemed once, and `data` is bound to that VAA, so the `(intentId, amount)` tuple cannot reach the router twice.

**`onBasejumpReceive(address asset, uint256 amount, bytes calldata data)`** — invoked by `BasejumpLanding` atomically with token delivery.

1. Requires `msg.sender == basejumpLanding`
2. Requires `asset == usdc`
3. Decodes `intentId` from `data`
4. Approves `omniBridge` for `amount`
5. Calls `omniBridge.deposit(usdc, amount, serviceAccount, memo = intentId)` — locks USDC on Ethereum and mints `nep141:eth.bridge.near` credited to `serviceAccount` on `intents.near`, tagged with the intent ID
6. Emits `IntentForwarded(intentId, amount)`

Any revert in this path (e.g. OmniBridge paused, USDC frozen) bubbles up and reverts the entire `Basejump.completeTransfer`. The user's funds remain claimable via the slow TokenBridge path into BasejumpLanding.

**`sweep(asset, to, amount)`** — owner-only escape hatch for stuck funds (e.g. unexpected token deposits, or USDC sent directly to the router outside the Basejump callback flow).

### Off-chain — `nintent` orchestrator

Long-running TypeScript service, structured like the existing `agents/bjscan` and `agents/broadcaster` packages. Bundles to a single `dist/index.js` via the shared [esbuild.config.mjs](../../esbuild.config.mjs).

**Responsibilities:**

1. **Quote API** — REST endpoint the frontend hits to obtain a live solver quote for `(srcAsset = USDC.eth, srcAmount, destAsset, destChain, destRecipient)`. Returns: quote ID, expected output, expiry, and the intent message to sign.
2. **Intent registry** — stores user-signed intents keyed by intent ID. The intent ID is the hash of the intent message, embedded as the Basejump `data` field and reused as the OmniBridge memo.
3. **Forward watcher** — subscribes to `IntentForwarded` events on `NearIntentsRouter`. This is the signal that the EVM-side forward has completed atomically with Basejump delivery; the orchestrator then waits for the corresponding OmniBridge deposit confirmation on NEAR (~10–20 min for ETH finality).
4. **Intent submitter** — once OmniBridge confirms the deposit on NEAR, submits the signed intent quote to NEAR Intents (`intents.near`). The service NEAR account spends the deposited `nep141:eth.bridge.near` balance under the user's signed intent.
5. **Settlement monitor** — watches NEAR Intents for solver fulfillment; reports completion to the user via the API.
6. **Failure path (manual for V1)** — if the intent expires before deposit confirmation on NEAR, the operator reverses the position: bridges USDC back from Ethereum to Hydration via Basejump and returns it to the user.

Note: the orchestrator has no role in the EVM-side forward — that step is atomic with Basejump delivery. Its responsibilities are NEAR-side (quote, sign, submit, monitor) plus the off-chain failure path.

**Intent ID** = `keccak256(abi.encode(user, srcAmount, destChain, destAsset, destRecipient, minOut, deadline, nonce))`. The same hash is used as:

- the `data` field on the Basejump VAA (carried end-to-end into `NearIntentsRouter.onBasejumpReceive`)
- the OmniBridge deposit memo, so the deposit can be matched to the user's intent on the NEAR side
- the lookup key in `nintent`'s registry, joining `IntentForwarded` events to user-signed intents

### NEAR side — third-party

`intents.near` (verifier), OmniBridge ERC20 locker, and the solver network are existing NEAR Intents components. Near Intents Bridge does not deploy anything on NEAR; it relies on:

| Component             | Role                                                                |
| --------------------- | ------------------------------------------------------------------- |
| `intents.near`        | Verifies intent signatures, debits/credits balances per fulfillment |
| OmniBridge (eth lock) | Locks USDC on Ethereum, mints `nep141:eth.bridge.near` on NEAR      |
| Solvers               | Provide destination asset (ZEC, BTC, …) on destination chain        |
| Service NEAR account  | Holds OmniBridge deposit credit, signs quote on user's behalf       |

## Flow

See [schema.md](schema.md) for full chain-hop diagrams.

End-to-end happy path:

1. **Quote** — user requests a quote (USDC.hydration → ZEC.zcash) from `nintent` API.
2. **Sign** — user receives an intent payload, signs it with their service-account-delegated key. `nintent` registers the intent.
3. **Bridge** — user initiates Basejump transfer on Hydration with `recipient = NearIntentsRouter` and `data = intentId` (computed from their signed intent).
4. **Fast-path delivery + forward (atomic)** — Wormhole fast VAA → `Basejump.completeTransfer` on Ethereum → `BasejumpLanding.transfer(USDC, netAmount, NearIntentsRouter, intentId)` → `NearIntentsRouter.onBasejumpReceive` → OmniBridge deposit, all in one transaction (~2 min). Emits `IntentForwarded(intentId, amount)`.
5. **Mint on NEAR** — `nep141:eth.bridge.near` credited to service account on `intents.near` (~10–20 min for ETH finality).
6. **Submit intent** — `nintent` submits the user-signed quote to `intents.near`.
7. **Solver fulfills** — solver delivers ZEC to user's Zcash address; `intents.near` settles the balance.
8. **Basejump slow settles** — ~13 min after step 3, TokenBridge transfer finalizes and replenishes `BasejumpLanding`'s pool on Ethereum. Independent of steps 4–7.

## Interface

- `IBasejumpReceiver.sol` (shared) — `onBasejumpReceive(address asset, uint256 amount, bytes calldata data)`. Implemented by any contract that wants atomic post-delivery hooks from Basejump.
- `INearIntentsRouter.sol` — extends `IBasejumpReceiver` with `sweep(address asset, address to, uint256 amount)`, events `IntentForwarded`, `Swept`. `data` MUST decode to `bytes32 intentId`.
- `nintent` HTTP API — `POST /quote`, `POST /intent`, `GET /intent/:id` (status). To be documented inside the `agents/nintent/` package alongside `broadcaster` and `bjscan`.

## Key Design Decisions

1. **Reuse Basejump for the EVM leg, with a small generic extension.** No new transport, no parallel VAA scheme. The only change to Basejump is an opaque `bytes data` field on the VAA payload and a post-delivery callback into recipients that implement `IBasejumpReceiver`. This is reusable by future Basejump consumers, not specific to NIR.
2. **Atomic delivery + forward.** `BasejumpLanding.transfer` and `NearIntentsRouter.onBasejumpReceive` execute in the same transaction. If the OmniBridge deposit reverts, the entire fast-path completion reverts; the slow TokenBridge path still settles into `BasejumpLanding`, so user funds are never stranded at the router. This removes a keeper, a replay guard, and a window during which funds sit idle.
3. **Off-chain orchestration only where it must be.** Quote discovery, intent signing, NEAR-side submission, and settlement monitoring are off-chain — they require live solver pricing, user signatures, and NEAR finality that don't fit on-chain. The EVM-side forward is deterministic and stays on-chain.
4. **Intent ID as correlation primitive.** The same `keccak256` hash threads through the Basejump VAA `data` field, the OmniBridge memo, and the orchestrator's registry. No separate cross-chain message is needed — the hash is the message.
5. **Service NEAR account holds the deposit.** Avoids onboarding Hydration users into NEAR-native key management. The trust assumption matches V1 Basejump's "single trusted relayer" model: the orchestrator is custodial for the brief window between OmniBridge mint and intent fulfillment.
6. **Auth boundary is `basejumpLanding`, not an orchestrator.** `onBasejumpReceive` is callable only by the authorized `BasejumpLanding`. There is no `forward` for external callers to grief, and no replay map: a VAA can only be redeemed once, and `data` is bound to the VAA.
7. **No on-chain failure handling in V1.** Expired/unfulfilled intents are rare in practice (NEAR Intents quotes have short TTLs and solvers are competitive); when they do occur, the operator unwinds manually via reverse Basejump. On-chain refund logic is deferred to V2.
8. **`sweep` as escape hatch.** Slow-settlement USDC arrives at `BasejumpLanding`, not at the router — but operator error or unexpected token deposits should still be recoverable. `sweep` is owner-only.

## How Existing Contracts Map

| Contract / Component | Role                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BasejumpProxy`      | On Moonbeam. Hydration's outbound proxy. `bridgeViaWormhole` extended with `bytes data` (carries `intentId`); encodes `data` into the VAA payload |
| `Basejump`           | On Ethereum. Inbound completion. `completeTransfer(vaa)` decodes `data` from the VAA and dispatches to `BasejumpLanding.transfer(..., data)`      |
| `BasejumpLanding`    | On Ethereum. Pre-funded USDC pool; pays out to `NearIntentsRouter` and atomically invokes its `onBasejumpReceive(asset, amount, data)` callback   |
| `NearIntentsRouter`  | New — `IBasejumpReceiver` that deposits arriving USDC to OmniBridge with the intent ID as memo                                                    |
| `OmniBridge`         | Third-party — locks USDC on Ethereum, mints wrapped on NEAR                                                                                       |
| `intents.near`       | Third-party — NEAR Intents verifier; settles user-signed quotes                                                                                   |
| `nintent` agent      | New off-chain — quote API, intent registry, NEAR-side intent submission, settlement watch                                                         |
