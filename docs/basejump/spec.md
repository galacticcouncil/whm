# Basejump

## Abstract

Standard Wormhole Token Bridge transfers require waiting for full guardian finality (~13 min on Ethereum). Users want tokens on the destination chain _now_.

## Overview

Two independent contracts — **Basejump** (transport) and **BasejumpLanding** (delivery) — deployed on every supported chain. Transport is decoupled from delivery, making the system chain-agnostic and composable.

## V1 Scope

- Three contracts: `Basejump` (source EVMs, MRL), `BasejumpProxy` (Moonbeam, XCM), `BasejumpLanding`
- Single token (EURC)
- Paths: Source EVM → Moonbeam GMP (MRL) → Hydration, Hydration → Moonbeam → Dest EVM (Wormhole)
- BasejumpLanding: simple pre-funded pool strategy (no Aave/Kamino integration yet)
- Trusted single relayer
- No timeout logic — happy path only
- Settlement: relayer redeems TokenBridge transfer, tokens land directly in BasejumpLanding

## Architecture

Three contracts, sharing a common base (`BasejumpBase`):

### `BasejumpBase` — Shared Logic (abstract)

Common storage, VAA verification & fee calculation. Subclasses implement `bridgeViaWormhole` (outbound) and `_executeTransfer` (inbound).

### `Basejump` — Source EVM Chains (Base, Ethereum, etc.)

Bridges funds **into** Hydration via Moonbeam GMP (MRL).

**Storage:**
- `landing` (bytes32) — BasejumpLanding on the current chain (for same-chain fast-path delivery)
- `landingDest` (bytes32) — BasejumpLanding on Hydration (MRL slow-path destination)

**`bridgeViaWormhole(asset, amount, recipient)`**

1. Calls `TokenBridge.transferTokensWithPayload()` — slow path via MRL. Recipient is Moonbeam GMP precompile (`0x816`), payload is SCALE-encoded `VersionedUserAction::V1` pointing to `landingDest` on Hydration (parachain 2034).
2. Calls `wormhole.publishMessage()` with **consistency level 200 (instant finality)** — encodes `sourceAsset`, `netAmount` (amount after fee), and `recipient`.

Destination chain is hardcoded as `MOONBEAM_WORMHOLE_ID = 16` — all transfers from source EVMs route through Moonbeam.

**`completeTransfer(vaa)`** — receives fast-path VAA, calls `BasejumpLanding.transfer()` via `landing` on the same chain.

### `BasejumpProxy` — Moonbeam (Hydration Proxy)

Bridges funds **out** from Hydration to external Wormhole chains.

**Storage:**
- `landings` (mapping uint16 → bytes32) — source chain ID → BasejumpLanding on Hydration (inbound fast-path delivery). Keyed by source chain so transfers from different chains can route to different landing contracts.
- `landingsDest` (mapping uint16 → bytes32) — dest chain ID → BasejumpLanding on destination (outbound slow-path recipient)

**`bridgeViaWormhole(asset, amount, destChain, recipient)`**

1. Calls `TokenBridge.transferTokens()` — slow path, recipient = `landingsDest[destChain]`.
2. Calls `wormhole.publishMessage()` with **consistency level 200** — encodes `sourceAsset`, `netAmount` (amount after fee), and `recipient`.

**`completeTransfer(vaa)`** — receives fast-path VAA, looks up `landings[sourceChain]` (from VAA emitter chain ID) and dispatches via `XcmTransactor` to the corresponding BasejumpLanding on Hydration.

### `BasejumpLanding` — Instant Delivery (Hydration)

Pre-funded liquidity pool on Hydration. Only callable by authorized bridge contracts. Delivers tokens to the recipient instantly using available liquidity, or queues transfers when liquidity is insufficient.

**`transfer(sourceAsset, amount, recipient)`** — called by authorized bridges

- Resolves destination asset via `destAssetFor[sourceAsset]` — owner-managed mapping of source→dest asset
- If sufficient balance: executes `currencies.transfer` via Hydration dispatch precompile (`0x0401`) to deliver `destAsset` to the recipient immediately
- If insufficient balance: queues a `PendingTransfer` (FIFO) for later fulfillment

**`fulfillPending()`** — processes the next pending transfer in queue

- Checks liquidity is now available for the next queued transfer
- Executes the transfer and removes it from the queue
- Anyone can call this (e.g. relayer, after settlement replenishes the pool)

**Settlement — automatic via TokenBridge**

- `bridgeViaWormhole()` sets the TokenBridge recipient to the BasejumpLanding contract address (via MRL on source EVMs, directly on BasejumpProxy)
- When the slow transfer finalizes (~13 min), relayer calls `TokenBridge.completeTransfer()` and tokens land directly in BasejumpLanding's balance
- No explicit `settle()` needed — the pool replenishes itself
- If transfers were queued, `fulfillPending()` can be called to drain the queue

**V1 delivery mechanism:**

BasejumpLanding on Hydration executes transfers via the dispatch precompile (`0x0401`), encoding a `currencies.transfer` extrinsic (pallet index 79, call index 0) with SCALE-encoded parameters. Currency ID is derived from the last 4 bytes of the dest asset address.

**Future implementations per chain:**

| Chain                 | BasejumpLanding Strategy                                  |
| --------------------- | ------------------------------------------------------- |
| Hydration (V1)        | Pre-funded pool, dispatch precompile for delivery        |
| Simple (any EVM)      | Direct ERC20 transfer from pre-funded pool               |
| Aave-supported chains | Flash-loan or borrow from Aave, repay on settlement     |
| Solana (Kamino)       | Borrow via Kamino, repay on settlement                  |

The key insight: BasejumpLanding doesn't know or care _how_ the bridge works. It just receives authorized `transfer()` calls and fulfills them using whatever liquidity strategy makes sense for that chain.

## Flow

See [schema.md](schema.md) for full architecture diagrams (both EVM → Hydration and Hydration → EVM directions).

## Interface

- [IBasejumpBase.sol](../../platforms/evm/contracts/src/interfaces/IBasejumpBase.sol) — shared events, errors, `completeTransfer`, `quoteFee`
- [IBasejump.sol](../../platforms/evm/contracts/src/interfaces/IBasejump.sol) — extends IBasejumpBase with `bridgeViaWormhole(asset, amount, recipient)`
- [IBasejumpProxy.sol](../../platforms/evm/contracts/src/interfaces/IBasejumpProxy.sol) — extends IBasejumpBase with `bridgeViaWormhole(asset, amount, destChain, recipient)`
- [IBasejumpLanding.sol](../../platforms/evm/contracts/src/interfaces/IBasejumpLanding.sol)

## Key Design Decisions

1. **Separation of concerns** — Basejump handles transport, BasejumpLanding handles delivery. Either can be upgraded or replaced independently.
2. **Moonbeam as thin proxy** — Moonbeam only verifies VAAs and dispatches XCM to Hydration. Holds no funds, no liquidity risk.
3. **BasejumpLanding authorization** — only whitelisted bridge contracts can call `transfer()`. Owner manages the whitelist. This is the security boundary.
4. **Auto-settlement** — TokenBridge recipient is set to BasejumpLanding address. Tokens arrive directly when the slow transfer completes. Pool balance is the accounting.
5. **Fee** — Basejump deducts a per-asset fee (`assetFee[asset]`) from the transfer amount before encoding the fast-path message. TokenBridge sends the full `amount` (slow settlement), but the instant message encodes `amount - fee`. BasejumpLanding delivers the net amount; the fee accrues as surplus in BasejumpLanding's balance when the slow settlement arrives.
6. **Asset mapping** — `destAsset` is not passed by the caller. BasejumpLanding maintains an owner-managed `destAssetFor[sourceAsset]` mapping that resolves the local destination asset for each source asset. The off-chain layer only needs to know the source asset address.
7. **Future-proof transport** — want to switch from Wormhole to Snowbridge? Deploy a new bridge contract, authorize it on BasejumpLanding, done. BasejumpLanding doesn't change.
8. **Pending queue** — when BasejumpLanding lacks liquidity, transfers are queued (FIFO) rather than reverted. `fulfillPending()` drains the queue once the pool is replenished by settlement.
9. **Timeout / bad debt** — if slow transfer never arrives, BasejumpLanding needs a fallback. Options: governance clawback, insurance fund, or relayer bond.

## How Existing Contracts Map

| Contract          | Role                                                              |
| ----------------- | ----------------------------------------------------------------- |
| `MessageReceiver` | Base — VAA verification, replay protection, emitter authorization |
| `XcmTransactor`   | SCALE-encodes evm.call and dispatches via XCM to Hydration        |
