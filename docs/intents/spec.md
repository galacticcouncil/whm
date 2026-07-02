# Intents

## Abstract

Hydration users hold assets and want assets on chains Hydration doesn't reach — Bitcoin, Zcash, Solana SPLs, NEAR-native tokens. NEAR Intents already settles swaps across all of these chains through the Defuse / OneClick flow. Near Intents Bridge connects the two: a single Hydration extrinsic swaps the user's chosen Hydration asset to WETH, bridges it to Ethereum via Moonbeam + Wormhole, and forwards native ETH into the quote-specific `depositAddress` returned by the OneClick API. After that deposit tx lands, `nintent` calls `submitDepositTx({ depositAddress, txHash })` so the quoted swap can continue and a solver delivers the destination asset (e.g. ZEC) to the user's wallet on the destination chain.

## Two delivery variants — WTT (deployed) and BJP

The Moonbeam→Ethereum leg has two implementations, chosen by how fast the **source** chain finalizes (see [relay-fee.md](relay-fee.md) for the full comparison):

| | **WTT** — Wrapped-Token-Transfer (**deployed**) | **BJP** — Basejump pooled (alternative) |
| --- | --- | --- |
| Transport | Wormhole **TokenBridge** `transferTokensWithPayload` (payload-3) | `BasejumpProxy.bridgeViaWormhole` (fast VAA + slow TokenBridge replenish) |
| Wormhole messages | **1** | **2** |
| Destination liquidity | None — tokens delivered straight through | Pre-funded landing pool fronts; slow transfer replenishes |
| Ethereum contract | `IntentReceiver` (`redeem`) | `Basejump` → `BasejumpLandingNative` → `IntentRouter` |
| Hydration contract | `IntentEmitterWtt` | `IntentEmitterBjp` |
| Relayer | **Permissionless** market, `maxRelayFee` ceiling | Permissioned trusted bot, gated pool reimbursement |
| When it wins | Source finalizes fast (Moonbeam → seconds) | Source finality slow |

**This spec documents WTT** — the deployed path (`nintent-ethereum` migration). Moonbeam finalizes in ~seconds, so fronting liquidity from a pre-funded pool to beat slow source finality buys nothing for this direction; the direct TokenBridge transfer is simpler and self-policing. The BJP variant (`IntentEmitterBjp`, `IntentRouter`, the Basejump landing pool — see [basejump/spec.md](../basejump/spec.md)) remains in the codebase for source chains where finality is slow enough to need the pooled fast-path; it is not the deployed intents path. Both emitters share the abstract [`IntentEmitter`](../../contracts/src/intents/IntentEmitter.sol) base (swap + fee + XCM batch + dispatch) and differ only in the `_bridgeViaWormholeCall` hook.

## Overview

The bridge composes two systems: the **Wormhole TokenBridge** (a payload-carrying token transfer, Moonbeam → Ethereum) and **NEAR Intents / Defuse OneClick** (origin-chain deposits → quoted destination asset, solver settled). On Hydration, the `IntentEmitterWtt` contract, in one atomic extrinsic via the DISPATCH precompile: (1) buys a fixed GLMR cross-chain fee and swaps the rest of the user's asset to WETH on the Hydration router, then (2) dispatches `batch_all([reserve-transfer WETH+GLMR to its Moonbeam MDA, send→Transact])`. The Transact runs **as the MDA** on Moonbeam and, through the Batch precompile, approves the Wormhole TokenBridge and calls `transferTokensWithPayload(WETH, ethOut, Ethereum, IntentReceiver, nonce=0, payload = (intentId, depositAddress, maxRelayFee))` — a single guardian-signed VAA carrying both the WETH and the intent payload. On Ethereum any relayer calls `IntentReceiver.redeem(vaa, feeRequested)`: the TokenBridge releases the WETH to the receiver, which unwraps it to native ETH, pays the relayer `feeRequested` (bounded by the user-signed `maxRelayFee` ceiling in the payload), and forwards the rest to the OneClick `depositAddress`. The off-chain `mrelayer` submits the VAA (pulling its fee from the `quoter` service); `nintent` then nudges OneClick's deposit detector. The user obtains a live OneClick quote off-chain for `originAsset = ETH.eth`; everything after `IntentEmitterWtt.swapAndBridge(...)` is automated.

## V1 Scope

- Two new contracts (WTT path):
  - `IntentEmitterWtt` on Hydration — swaps any Hydration asset → WETH and bridges it through the Wormhole TokenBridge with a payload, in one extrinsic
  - `IntentReceiver` on Ethereum — redeems the payload-3 VAA, unwraps WETH → native ETH, pays the relay fee, and forwards native ETH to the quote deposit address
- Source asset (user side): **any Hydration asset** `A` the router can sell to WETH (GLMR and WETH are special-cased). The bridged/origin asset for the quote is **ETH** (WETH on Hydration/Moonbeam → native ETH at the deposit address).
- Asset + trigger transport: **XCM reserve-transfer** Hydration → Moonbeam (WETH + GLMR to the emitter's MDA), then a **single** Wormhole **TokenBridge** `transferTokensWithPayload` Moonbeam → Ethereum. One message carries both the WETH and the `(intentId, depositAddress, maxRelayFee)` payload — no separate fast/slow legs, no pool.
- Intent hop: Ethereum ETH → OneClick quote deposit → NEAR Intents → destination asset on destination chain
- Quote model: `OneClickService.getQuote(originAsset = ETH.eth, ...)` returns quote details plus a quote-specific `depositAddress` on Ethereum
- Completion model: OneClick auto-detects deposits on `depositAddress` and starts processing on receipt; `OneClickService.submitDepositTx({ depositAddress, txHash })` is an optional latency optimization (~poller interval → ~seconds)
- Payload: the TokenBridge transfer carries a 96-byte payload `(bytes32 intentId, address depositAddress, uint256 maxRelayFee)`, authenticated end-to-end inside the guardian-signed VAA
- Native unwrap: `IntentReceiver` unwraps the delivered token to native ETH **only when** it equals the configured `wrappedNative` (WETH); any other delivered token is forwarded as the delivered ERC20 (graceful degrade, never bricks)
- Relay fee: charged on the **destination**, native-in/native-out (no FX). The relayer names `feeRequested`; the contract enforces `feeRequested ≤ maxRelayFee` and forwards `amount − feeRequested`. Permissionless market; an optional `authorizedRelayer` allowlist grants a 5-minute exclusivity window per VAA before redemption opens to anyone (liveness fallback). See [relay-fee.md](relay-fee.md).
- `redeem` is **permissionless and replay-safe** — the payload (not the caller) dictates the destination; the TokenBridge restricts completion to the encoded recipient and marks the VAA consumed
- Single `nintent` headless keeper: watches `IntentForwarded` events on `IntentReceiver` and calls `OneClick.submitDepositTx({ depositAddress, txHash })` as a latency optimization. OneClick auto-detects deposits without it; nintent just makes detection ~seconds instead of one poller interval. No HTTP API, no quote-path involvement, no per-quote registry. Quote acquisition is UI ↔ OneClick direct. Failure unwind is operator-driven outside the agent.
- Supported destinations: any NEAR Intents-listed asset/chain pair supported by the quote API (ZEC/Zcash, BTC/Bitcoin, NEAR/NEAR, …)
- No on-chain failure handling — happy path only; expired or rejected quotes are unwound off-chain (see [refund.md](refund.md))
- No shared NEAR recipient account in the NIR path — the quote's origin-chain `depositAddress` is used directly

## Architecture

Four layers — Hydration entry (`IntentEmitterWtt`: swap + dispatch), the Moonbeam hop (the emitter's MDA approves + calls the Wormhole TokenBridge), Ethereum delivery (`IntentReceiver.redeem`), and the off-chain actors (`mrelayer` redeems the VAA, `nintent` nudges OneClick). The asset and the trigger travel the **same** route as a **single** Wormhole message (Hydration → Moonbeam → Wormhole TokenBridge → Ethereum).

### Hydration — `IntentEmitterWtt`

The entry point on Hydration. Holds no liquidity in the happy path. Swaps the user's asset to WETH, reserves a GLMR fee for the cross-chain hop, and dispatches the bridge — all in one extrinsic through the DISPATCH precompile (`0x0401`). UUPS-upgradeable; extends the abstract [`IntentEmitter`](../../contracts/src/intents/IntentEmitter.sol).

**Storage / config:**

- `owner` / `xcmOperators` — owner controls upgrades and path wiring; xcm operators tune fee/gas params
- `tokenBridge` — address (H160) of the Wormhole **TokenBridge** on Moonbeam (the MDA approves + calls it)
- `intentReceiver` — `bytes32` Wormhole recipient: the Ethereum `IntentReceiver` the payload-3 transfer targets
- `xcmSource` — the emitter's Moonbeam **MDA** (derived sibling-EVM AccountId32 → H160), computed at init; the assets are reserve-transferred to it and the Transact runs as it
- `xcmFee` / `xcmExecutionFee` / `xcmGasLimit` / `xcmTransactRefTime` / `xcmTransactProofSize` — XCM transport/weight parameters (operator-tunable via `setXcmParams`)
- constant `ETHEREUM_WORMHOLE_ID = 2`

**`swapAndBridge(uint32 assetIn, uint256 amountIn, uint256 minEthOut, uint256 maxFeeIn, bytes32 intentId, address intentDepositAddress, uint256 maxRelayFee)`** — single user entry. In one extrinsic:

1. Pulls `amountIn` of asset `A` (`assetIn`) from the caller.
2. **Swap** (`_swap`): reserve the fixed `xcmFee` of GLMR for the hop, then convert the rest of `A` to WETH on the Hydration router.
   - `A == GLMR`: withhold `xcmFee`, sell `amountIn − xcmFee` → WETH.
   - else: buy `xcmFee` GLMR with `A`, spending at most `maxFeeIn` of `A` (caller's fee-leg slippage bound); then sell the caller's leftover `A` → WETH (skipped when `A == WETH`).
3. Slippage check: `wethOut` (WETH produced this call) must be `≥ minEthOut`, else revert `InsufficientOutput`.
4. **Bridge** (`_bridge`): DISPATCH `utility.batch_all([` `polkadotXcm.transfer_assets_using_type_and_then` (reserve-transfer `[GLMR fee, WETH]` to the MDA on Moonbeam)`,` `polkadotXcm.send` → Transact **as the MDA** running Moonbeam's Batch precompile: `WETH.approve(tokenBridge, ethOut)` then `TokenBridge.transferTokensWithPayload(WETH, ethOut, ETHEREUM_WORMHOLE_ID, intentReceiver, nonce=0, abi.encode(intentId, intentDepositAddress, maxRelayFee))` `])`.
5. Emits `BridgeInitiated(intentId, caller, assetIn, amountIn, ethOut, intentDepositAddress)`.

If any step fails the whole extrinsic reverts — no partial state. Only the caller's own `A` is swapped; stray/donated `A` resident in the contract is left untouched. See [fee.md](fee.md) for sizing `amountIn` / `minEthOut` / `maxFeeIn` / `maxRelayFee`.

### Moonbeam hop — the emitter's MDA + Wormhole TokenBridge

The reserve-transfer credits the emitter's **Multilocation Derived Account** (`xcmSource`) on Moonbeam with the WETH + GLMR, and the `send` leg's Transact executes _as that MDA_ (sovereign origin). The Batch precompile, as the MDA:

1. `WETH.approve(tokenBridge, ethOut)`
2. `TokenBridge.transferTokensWithPayload(WETH, ethOut, ETHEREUM_WORMHOLE_ID, intentReceiver, nonce=0, payload)` — locks the WETH on Moonbeam and publishes a **single** payload-3 Wormhole message (`LogMessagePublished`) whose recipient is the Ethereum `IntentReceiver` and whose payload is `(intentId, depositAddress, maxRelayFee)`.

One message both moves the value and carries the intent — there is no second leg, no pool to keep solvent, and nothing to replenish. The WETH crosses as the canonical Wormhole-wrapped asset and is delivered to the receiver on redemption.

### Ethereum — `IntentReceiver`

A single Ethereum contract that holds no liquidity in the happy path — it redeems, unwraps, pays the relayer, and forwards. UUPS-upgradeable. Initialized with `(tokenBridge, wrappedNative)`.

**Storage:**

- `owner`
- `tokenBridge` — the Ethereum Wormhole TokenBridge used to complete the transfer
- `wrappedNative` — the canonical wrapped-native (WETH) that is unwrapped to native ETH on delivery; any other delivered token is forwarded as-is
- `authorizedRelayer` / `authorizedRelayerCount` — optional relayer allowlist (see exclusivity window below)
- constants: `NATIVE` sentinel (matches the native-ETH payout marker), `EXCLUSIVE_WINDOW = 5 minutes`

**`redeem(bytes vaa, uint256 feeRequested)`** — permissionless. In one transaction:

1. **Freshness guard** — `parseVM(vaa)`; revert `AlreadyRedeemed` if `tokenBridge.isTransferCompleted(hash)` (cheap check before the expensive signature verification).
2. **Complete** — `tokenBridge.completeTransferWithPayload(vaa)` releases the token to this contract and returns the `TransferWithPayload` body. The TokenBridge enforces that the recipient encoded in the VAA is this contract and marks the VAA consumed (replay-safe).
3. Resolve the **delivered** ERC20 (canonical token if home-chain, else the wrapped form) and read `amount = balanceOf(delivered)` — the receiver holds no liquidity between redeems, so its balance _is_ what this VAA released. Revert `NothingDelivered` if zero.
4. Require `payload.length == 96`; decode `(intentId, depositAddress, maxRelayFee)`; require `depositAddress != 0` (else `MalformedPayload`).
5. **Exclusivity window** — if `authorizedRelayerCount > 0` and the caller is not an authorized relayer, require `block.timestamp ≥ vaa.timestamp + EXCLUSIVE_WINDOW` (else `Unauthorized`). While the allowlist is empty, redemption is fully permissionless at any time.
6. **Fee** — require `feeRequested ≤ maxRelayFee` (else `FeeExceedsCeiling`); `forwardAmount = amount − feeRequested`.
7. **Settle in the delivered asset** — if `delivered == wrappedNative`, `withdraw` it to native ETH and set `asset = NATIVE`; otherwise forward the delivered ERC20 (`asset = delivered`).
8. `_pay(asset, depositAddress, forwardAmount)` and emit `IntentForwarded(intentId, asset, depositAddress, forwardAmount)`.
9. If `feeRequested > 0`, `_pay(asset, msg.sender, feeRequested)` and emit `RelayFeePaid(intentId, msg.sender, feeRequested)`.

Any revert in this path bubbles up and reverts the whole `redeem`, leaving the VAA **redeemable for retry** (it is only marked consumed on success). Funds are never stranded — the WETH stays locked on Moonbeam against an unredeemed VAA until a successful redeem.

**`sweep(asset, to, amount)`** — owner-only escape hatch for stuck funds (native ETH via the `NATIVE` sentinel, or stray tokens). **`setOwner` / `setWrappedNative` / `setAuthorizedRelayer`** — owner-only wiring.

### Off-chain — `mrelayer` (redeem) + `nintent` (deposit nudge)

Two headless TypeScript services, structured like the existing `agents/*` packages and bundled to a single `dist/index.js`.

**`mrelayer`** ([app-intent.ts](../../agents/mrelayer/src/app-intent.ts)) — the VAA relayer for the WTT path. Polls Wormhole for payload-3 transfers to Ethereum addressed to the configured `IntentReceiver`, fetches a `feeRequested` from the `quoter` service (sized against the live Ethereum gas cost, bounded by the VAA's `maxRelayFee`), and calls `IntentReceiver.redeem(vaa, feeRequested)`. Redemption is a permissionless race: the first `redeem` to land wins (the TokenBridge marks the VAA consumed) and losing txs revert with `AlreadyRedeemed`. The operator runs `mrelayer` as the backstop relayer for liveness; anyone may also relay. Relay-fee economics: [relay-fee.md](relay-fee.md).

**`nintent`** ([watcher.ts](../../agents/nintent/src/watcher.ts)) — subscribes to `IntentForwarded(intentId, asset, depositAddress, amount)` on `IntentReceiver`, captures `depositAddress` and the Ethereum tx hash from the event, and calls `OneClickService.submitDepositTx({ depositAddress, txHash })` (deduped by `(txHash, depositAddress)`).

`submitDepositTx` is **not required for the swap to complete** — OneClick polls the origin chain for the `depositAddress` it issued and starts processing on receipt automatically. `nintent` only compresses detection latency from a poller interval to ~seconds. It exposes no HTTP API and stores no per-quote registry; the UI talks to OneClick directly for quote acquisition and status polling. If `nintent` is down, swaps still complete — just slower.

Operator-driven failure unwind (expired quote, rejected deposit) is a manual process handled outside the agents in V1. See [refund.md](refund.md).

**Intent ID** = local correlation hash computed by the UI from the accepted quote, for example:

`keccak256(abi.encode(quoteId, depositAddress, srcAmount, destAsset, destRecipient, deadline, nonce))`

The same hash is used as:

- the `intentId` argument to `IntentEmitterWtt.swapAndBridge(...)` and in the TokenBridge payload, carried end-to-end into `IntentReceiver.redeem`
- the first field of the `BridgeInitiated` (Hydration) and `IntentForwarded` (Ethereum) events, observable on-chain
- the correlation key in logs and analytics (joining Hydration `BridgeInitiated`, the Moonbeam `LogMessagePublished` sequence, Ethereum `IntentForwarded`, and OneClick status records off-chain)

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
2. **Accept** — user reviews and accepts the live quote in the UI. The UI computes the local `intentId` and sizes `amountIn` / `minEthOut` / `maxFeeIn` / `maxRelayFee` (see [fee.md](fee.md) and [relay-fee.md](relay-fee.md)). `nintent` is not involved.
3. **Hydration atomic dispatch** — user calls `IntentEmitterWtt.swapAndBridge(assetIn, amountIn, minEthOut, maxFeeIn, intentId, depositAddress, maxRelayFee)`. In one extrinsic the emitter buys the GLMR fee, swaps `A → WETH`, and dispatches `batch_all([reserve-transfer WETH+GLMR → MDA, send→Transact])`. Emits `BridgeInitiated`.
4. **Moonbeam → Wormhole** — the Transact runs as the MDA and calls `TokenBridge.transferTokensWithPayload(WETH, ethOut, ETHEREUM_WORMHOLE_ID, IntentReceiver, nonce=0, payload)`, locking the WETH and publishing a single payload-3 VAA (`LogMessagePublished`).
5. **Ethereum redeem** — `mrelayer` picks up the VAA, fetches `feeRequested` from the `quoter`, and calls `IntentReceiver.redeem(vaa, feeRequested)`: the TokenBridge releases the WETH, the receiver unwraps it to native ETH, pays the relayer `feeRequested`, and forwards `amount − feeRequested` to `depositAddress`. Emits `IntentForwarded(intentId, NATIVE, depositAddress, forwardAmount)` (and `RelayFeePaid`).
6. **Submit deposit tx (optional speedup)** — `nintent` observes `IntentForwarded`, reads `depositAddress`, and calls `OneClickService.submitDepositTx({ depositAddress, txHash })`. If `nintent` is unavailable, OneClick still picks up the deposit via its own poller.
7. **Quote processing** — the quote service detects the deposit and starts the quoted NEAR Intents flow.
8. **Solver fulfills** — solver delivers the destination asset to the user's destination-chain address.

## Interface

- `IIntentEmitter` (Hydration) — `swapAndBridge(uint32 assetIn, uint256 amountIn, uint256 minEthOut, uint256 maxFeeIn, bytes32 intentId, address intentDepositAddress, uint256 maxRelayFee)`; event `BridgeInitiated(bytes32 intentId, address caller, uint32 assetIn, uint256 amountIn, uint256 ethOut, address intentDepositAddress)`; admin `setOwner`/`setXcmOperator`/`setXcmParams`. The WTT variant adds `setTokenBridge`/`setIntentReceiver`; `maxRelayFee` is embedded in the payload by WTT and ignored by BJP.
- `IIntentReceiver.sol` (Ethereum, WTT) — `redeem(bytes vaa, uint256 feeRequested)`; events `IntentForwarded(bytes32 intentId, address asset, address depositAddress, uint256 amount)`, `RelayFeePaid(bytes32 intentId, address relayer, uint256 fee)`, `Swept`, `WrappedNativeUpdated`, `RelayerAuthorized`; admin `setOwner`/`setWrappedNative`/`setAuthorizedRelayer`/`sweep`. The TokenBridge payload MUST decode to `(bytes32 intentId, address depositAddress, uint256 maxRelayFee)` (96 bytes).
- `nintent` exposes no public HTTP API. It is a headless event-driven keeper: chain subscription in, `submitDepositTx` out. Operator-facing logs and metrics only. The UI talks to OneClick directly for both quote acquisition and status polling.
- (BJP alternative, not deployed) `IBasejumpReceiver.sol` + `IIntentRouter.sol` — the Basejump-path receiver surface; see [basejump/spec.md](../basejump/spec.md).

## Fees

Full breakdown and sizing guidance: **[fee.md](fee.md)** (the swap + transport legs) and **[relay-fee.md](relay-fee.md)** (the destination relay fee). In short, value crosses these charged surfaces:

- **`xcmFee` (GLMR transport)** — bought from `A` on Hydration, bounded by the caller's `maxFeeIn`. Pays the XCM arrival + remote `BuyExecution` (`xcmExecutionFee`). Operator-tunable.
- **`minEthOut` (swap floor)** — caller's slippage bound on the WETH the Hydration swap produces (the amount bridged).
- **`maxRelayFee` (destination relay ceiling)** — user-signed ETH ceiling carried in the VAA payload. The relayer claims `feeRequested ≤ maxRelayFee` on redemption (paid in the delivered asset); competition keeps it at the relayer's true gas cost + margin. A too-low ceiling is a liveness issue (the VAA sits unredeemed), never a loss.

The OneClick quote takes its own spread on the NEAR side (reflected in the quote, not charged on-chain). Sizing target: `value(amountIn) ≳ xcmFee + maxRelayFee + oneClick.requiredDeposit`.

## Key Design Decisions

1. **One extrinsic, one message.** Swap + `batch_all` dispatch are atomic on Hydration; the WETH and the intent payload cross as a **single** Wormhole TokenBridge `transferTokensWithPayload`. No fast/slow split, no pool, no gating — the transfer carries its own value and is delivered on redemption.
2. **Direct TokenBridge over a pooled fast-path for this direction.** Moonbeam finalizes in ~seconds, so fronting liquidity from a pre-funded landing pool to beat slow source finality buys nothing. WTT skips the pool entirely; BJP exists for source chains where finality is slow enough to justify it.
3. **Any Hydration asset in, ETH out.** The user picks any asset the router can sell; the emitter buys the GLMR fee and swaps the rest to WETH. OneClick's `ETH → *` quote graph is the broadest origin, so the bridged/origin asset is always ETH.
4. **WETH on Hydration/Moonbeam, native ETH at the deposit.** The receiver unwraps the delivered WETH to native ETH and forwards native ETH to the OneClick `depositAddress` (which expects `originAsset = ETH.eth`). Unwrap happens only when the delivered token equals the configured `wrappedNative`; anything else degrades to an ERC20 forward instead of bricking.
5. **Permissionless, replay-safe redemption.** The payload — not the caller — dictates the destination. The TokenBridge restricts `completeTransferWithPayload` to the encoded recipient and marks the VAA consumed, so a malicious relayer can neither redirect funds nor double-spend. An optional `authorizedRelayer` allowlist grants a 5-minute exclusivity window per VAA, then opens to anyone (liveness fallback).
6. **Caller-set slippage on both swap legs + a relay-fee ceiling.** `minEthOut` bounds the swap output; `maxFeeIn` bounds the asset spent buying the GLMR fee; `maxRelayFee` bounds the destination relay claim — so neither a thin route nor an over-charging relayer can silently extract value.
7. **Self-policing relay market.** A single message both delivers to the recipient and pays its redeemer, so the fee can be fully permissionless: the relayer names `feeRequested ≤ maxRelayFee`, competition drives it toward true cost, and an unprofitable job simply goes unrelayed (funds safe). See [relay-fee.md](relay-fee.md).
8. **`submitDepositTx` as the NEAR-side continuation.** `nintent` hands OneClick the quoted `depositAddress` and the actual Ethereum tx hash — the canonical signal to continue processing.
9. **Intent ID as local correlation primitive.** Computed by the UI, threaded through `IntentEmitterWtt`, the TokenBridge payload, and the `BridgeInitiated` / `IntentForwarded` events. The deposit recipient is `depositAddress`, not `intentId`.
10. **Reverts are recoverable, not lost.** A failed forward reverts the whole `redeem`, and the VAA is only marked consumed on success — so it stays redeemable for retry; the WETH remains locked on Moonbeam against the unredeemed VAA. MDA-stranding (if the remote Moonbeam leg fails) is recoverable by the owner via a Transact-as-MDA (today through a UUPS upgrade adding a recovery entrypoint).
11. **No on-chain failure handling in V1.** Expired or rejected quotes are handled operationally; on-chain refund logic is deferred. See [refund.md](refund.md).
12. **`sweep` as escape hatch.** Owner-only recovery of stray tokens or native ETH at the receiver.

## How Contracts Map

| Contract / Component    | Role                                                                                                                                                                                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IntentEmitter`         | **Abstract base** — on Hydration. Shared swap + GLMR-fee + XCM `batch_all` + dispatch. Variants override `_bridgeViaWormholeCall` (and `_encodePayload`).                                                                                                                          |
| `IntentEmitterWtt`      | **New, deployed** — WTT variant. The MDA approves the Wormhole TokenBridge and calls `transferTokensWithPayload(WETH, ethOut, Ethereum, IntentReceiver, payload = (intentId, depositAddress, maxRelayFee))`. One message; no Basejump.                                            |
| Wormhole TokenBridge    | Third-party transport (Moonbeam + Ethereum). `transferTokensWithPayload` locks WETH on Moonbeam and emits the payload-3 VAA; `completeTransferWithPayload` releases it to the receiver on Ethereum. (8-dec normalization — see relay-fee.md.)                                       |
| `IntentReceiver`        | **New, deployed** — on Ethereum. `redeem(vaa, feeRequested)` completes the transfer, unwraps WETH → native ETH, pays the relayer (`≤ maxRelayFee`), and forwards the rest to the OneClick `depositAddress`. Holds no liquidity in the happy path; permissionless + replay-safe.    |
| `mrelayer` agent        | **Off-chain** — VAA relayer. Polls for payload-3 transfers to `IntentReceiver`, sizes `feeRequested` via the `quoter`, calls `redeem`. Operator runs it as the liveness backstop; redemption is an open race.                                                                     |
| `quoter` agent          | **Off-chain** — relay-fee quoter the relayer reads to size `feeRequested` against live gas.                                                                                                                                                                                       |
| `nintent` agent         | **Off-chain** — headless keeper. Watches `IntentForwarded`, calls `submitDepositTx` as a latency optimization. No HTTP API, no registry. OneClick still completes swaps if `nintent` is offline.                                                                                  |
| Defuse / OneClick API   | Third-party — returns quote data, quote-specific `depositAddress`, accepts `submitDepositTx`.                                                                                                                                                                                     |
| `intents.near`          | Third-party — NEAR Intents settlement layer behind the quote flow.                                                                                                                                                                                                                |
| `IntentEmitterBjp` / `IntentRouter` / Basejump landing | **Alternative (not deployed for intents)** — the BJP pooled variant. See [basejump/spec.md](../basejump/spec.md) and the BJP column in [relay-fee.md](relay-fee.md).                                                                                |
