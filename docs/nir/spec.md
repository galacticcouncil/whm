# Near Intents

## Abstract

Hydration users hold liquid stablecoins (USDC) and want assets on chains Hydration doesn't reach — Bitcoin, Zcash, Solana SPLs, NEAR-native tokens. NEAR Intents is a solver network that already settles swaps across all of these chains, but its on-ramps are EVM and NEAR. Near Intents Bridge connects the two: Basejump ships USDC from Hydration to Ethereum, and an adapter forwards the funds into NEAR Intents with a user-signed quote so a solver delivers the destination asset (e.g. ZEC) to the user's wallet on the destination chain (e.g. Zcash).

## Overview

The bridge composes two existing systems: **Basejump** (Hydration ↔ EVM, fast-path delivery) and **NEAR Intents** (EVM/NEAR → any supported chain, solver settled). A single new on-chain adapter on Ethereum plus an off-chain orchestrator (`nintent`) glue them together. The user signs the NEAR intent quote off-chain; everything else is automated.

## V1 Scope

- One new contract: `NearIntentsRouter - NIR` on Ethereum (BasejumpLanding consumer, OmniBridge depositor)
- Source asset: USDC on Hydration
- Bridge hop: Hydration → Moonbeam → Ethereum (existing Basejump path)
- Intent hop: Ethereum USDC → NEAR Intents → destination asset on destination chain
- Trusted single `nintent` orchestrator (mirrors V1 Basejump relayer trust model)
- Supported destinations: any NEAR Intents-listed asset/chain pair (ZEC/Zcash, BTC/Bitcoin, NEAR/NEAR, SPL/Solana, …)
- No on-chain failure handling — happy path only; expired or unfulfilled intents are unwound off-chain
- No on-chain custody of NEAR account — orchestrator holds the service NEAR account that signs quotes

## Architecture

Four layers — Hydration entry (UX only), Basejump transport (reused), `NearIntentsRouter` on Ethereum, and the `nintent` off-chain orchestrator.

### Hydration → Ethereum — Basejump (unchanged)

The Hydration-side leg is plain Basejump. The user XCM-transfers USDC to Moonbeam's `BasejumpProxy` and calls `bridgeViaWormhole(USDC, amount, ETHEREUM_WORMHOLE_ID, recipient = NearIntentsRouter)`. From Basejump's perspective the recipient is just another address; the only thing special about it is that the recipient happens to be a contract that knows how to forward funds into NEAR Intents.

The fast-path VAA settles in ~2s and triggers `BasejumpLanding.transfer(USDC, netAmount, NearIntentsRouter)` on Ethereum, depositing USDC into the router's balance. The slow TokenBridge transfer settles ~13 min later and replenishes BasejumpLanding's pool. See [docs/basejump/spec.md](../basejump/spec.md) for the full transport details.

### Ethereum — `NearIntentsRouter`

A single Ethereum contract that holds no liquidity, only routes. Funds arrive from BasejumpLanding's `transfer()` payout; the router forwards them into NEAR Intents via OmniBridge.

**Storage:**

- `omniBridge` (address) — OmniBridge ERC20 locker on Ethereum
- `usdc` (address) — accepted source asset (V1: USDC)
- `serviceAccount` (string) — NEAR account that receives the deposit credit on `intents.near` (held by the `nintent` orchestrator)
- `orchestrator` (address) — authorized keeper allowed to call `forward`
- `forwarded` (mapping bytes32 → bool) — intent ID replay guard

**`forward(intentId, amount)`**

1. Verifies `intentId` is unused (`!forwarded[intentId]`)
2. Verifies the contract holds at least `amount` USDC (funds arrived via Basejump)
3. Approves `omniBridge` for `amount`
4. Calls `omniBridge.deposit(usdc, amount, serviceAccount, memo = intentId)` — locks USDC on Ethereum and mints `nep141:eth.bridge.near` credited to `serviceAccount` on `intents.near`, tagged with the intent ID
5. Marks `forwarded[intentId] = true`
6. Emits `IntentForwarded(intentId, amount)`

Permissioned to `orchestrator` so a malicious caller can't dust-attack the contract by submitting bogus intents against arriving funds.

**`sweep(asset, to, amount)`** — owner-only escape hatch for stuck funds (e.g. slow-settlement arrival after an intent has been unwound off-chain).

### Off-chain — `nintent` orchestrator

Long-running TypeScript service, structured like the existing `agents/bjscan` and `agents/broadcaster` packages. Bundles to a single `dist/index.js` via the shared [esbuild.config.mjs](../../esbuild.config.mjs).

**Responsibilities:**

1. **Quote API** — REST endpoint the frontend hits to obtain a live solver quote for `(srcAsset = USDC.eth, srcAmount, destAsset, destChain, destRecipient)`. Returns: quote ID, expected output, expiry, and the intent message to sign.
2. **Intent registry** — stores user-signed intents keyed by intent ID. The intent ID is the hash of the intent message, used as the Basejump `recipient` correlation tag and the OmniBridge memo.
3. **Bridge watcher** — subscribes to `BridgeInitiated` events on Hydration's Basejump proxy where `recipient = NearIntentsRouter`; correlates each event to a pending intent by amount + per-user nonce; waits for `TransferExecuted` on the Ethereum `BasejumpLanding`.
4. **Forwarder** — once funds arrive at `NearIntentsRouter`, submits the `forward(intentId, amount)` tx.
5. **Intent submitter** — once OmniBridge confirms the deposit on NEAR (~10–20 min for ETH finality), submits the signed intent quote to NEAR Intents (`intents.near`). The service NEAR account spends the deposited `nep141:eth.bridge.near` balance under the user's signed intent.
6. **Settlement monitor** — watches NEAR Intents for solver fulfillment; reports completion to the user via the API.
7. **Failure path (manual for V1)** — if the intent expires before deposit confirmation, the operator reverses the position: bridges USDC back from Ethereum to Hydration via Basejump and returns it to the user.

**Intent ID** = `keccak256(abi.encode(user, srcAmount, destChain, destAsset, destRecipient, minOut, deadline, nonce))`. The same hash is used as:

- the `recipient`-correlation key in `nintent`'s registry (matching `BridgeInitiated` events to signed intents)
- the OmniBridge deposit memo, so the deposit can be matched to the user's intent on the NEAR side

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
3. **Bridge** — user initiates Basejump transfer on Hydration with `recipient = NearIntentsRouter` and `nonce` chosen so the resulting intent ID matches their signed intent.
4. **Fast-path delivery** — Wormhole fast VAA → `BasejumpLanding.transfer` on Ethereum → USDC lands at `NearIntentsRouter` (~2 min).
5. **Forward** — `nintent` calls `NearIntentsRouter.forward(intentId, amount)` → OmniBridge deposit on Ethereum.
6. **Mint on NEAR** — `nep141:eth.bridge.near` credited to service account on `intents.near` (~10–20 min for ETH finality).
7. **Submit intent** — `nintent` submits the user-signed quote to `intents.near`.
8. **Solver fulfills** — solver delivers ZEC to user's Zcash address; `intents.near` settles the balance.
9. **Basejump slow settles** — ~13 min after step 3, TokenBridge transfer finalizes and replenishes `BasejumpLanding`'s pool on Ethereum. Independent of steps 4–8.

## Interface

- `INearIntentsRouter.sol` — `forward(bytes32 intentId, uint256 amount)`, `sweep(address asset, address to, uint256 amount)`, events `IntentForwarded`, `Swept`
- `nintent` HTTP API — `POST /quote`, `POST /intent`, `GET /intent/:id` (status). To be documented inside the `agents/nintent/` package alongside `broadcaster` and `bjscan`.

## Key Design Decisions

1. **Reuse Basejump end-to-end for the EVM leg.** No new transport, no parallel VAA scheme — `NearIntentsRouter` is just an unusual `recipient` from Basejump's point of view. The router never sees a VAA; it sees an ERC20 balance arrive and forwards it.
2. **Off-chain orchestration, on-chain forwarding.** Quote discovery, intent signing, and NEAR-side submission are off-chain — they require live solver pricing and short TTLs that don't fit on-chain. The on-chain router only does the deterministic part: USDC → OmniBridge deposit.
3. **Intent ID as correlation primitive.** The same `keccak256` hash threads through the registry, the Basejump nonce, and the OmniBridge memo. No separate cross-chain message is needed — the hash is the message.
4. **Service NEAR account holds the deposit.** Avoids onboarding Hydration users into NEAR-native key management. The trust assumption matches V1 Basejump's "single trusted relayer" model: the orchestrator is custodial for the brief window between OmniBridge mint and intent fulfillment.
5. **Permissioned `forward`.** Anyone who knows an unused intent ID could otherwise grief by triggering a deposit against funds intended for a different intent. Restricting `forward` to the orchestrator removes the attack surface.
6. **No on-chain failure handling in V1.** Expired/unfulfilled intents are rare in practice (NEAR Intents quotes have short TTLs and solvers are competitive); when they do occur, the operator unwinds manually via reverse Basejump. On-chain refund logic is deferred to V2.
7. **`sweep` as escape hatch.** Slow-settlement USDC arrives at `BasejumpLanding`, not at the router — but operator error or unexpected token deposits should still be recoverable. `sweep` is owner-only.

## How Existing Contracts Map

| Contract / Component | Role                                                                    |
| -------------------- | ----------------------------------------------------------------------- |
| `BasejumpProxy`      | Hydration → Ethereum transport (unchanged)                              |
| `BasejumpLanding`    | Pre-funded USDC pool on Ethereum; pays out to `NearIntentsRouter`       |
| `NearIntentsRouter`  | New — receives USDC, deposits to OmniBridge with intent ID memo         |
| `OmniBridge`         | Third-party — locks USDC on Ethereum, mints wrapped on NEAR             |
| `intents.near`       | Third-party — NEAR Intents verifier; settles user-signed quotes         |
| `nintent` agent      | New off-chain — quote API, intent registry, forwarder, settlement watch |
