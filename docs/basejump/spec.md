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

**`bridgeViaWormhole(asset, amount, destChain, destAsset, recipient)`**

1. Calls `TokenBridge.transferTokensWithPayload()` — slow path via MRL. Recipient is Moonbeam GMP precompile (`0x816`), payload is SCALE-encoded `VersionedUserAction::V1` pointing to BasejumpLanding on Hydration (parachain 2034).
2. Calls `wormhole.publishMessage()` with **consistency level 200 (instant finality)** — encodes `sourceAsset`, `destAsset`, `netAmount` (amount after fee), and `recipient`.

**`completeTransfer(vaa)`** — receives fast-path VAA, calls `BasejumpLanding.transfer()` directly on the same chain.

The `destAsset` is specified by the caller when calling `bridgeViaWormhole()`. It gets encoded into the instant message payload and forwarded to `BasejumpLanding.transfer()` on the destination chain. No on-chain derivation or registry needed — the off-chain layer (SDK/frontend) resolves the correct dest asset address based on the bridge type (Wormhole wrapped address, Snowbridge asset ID, etc.) and passes it in.

### `BasejumpProxy` — Moonbeam (Hydration Proxy)

Bridges funds **out** from Hydration to external Wormhole chains.

**`bridgeViaWormhole(asset, amount, destChain, destAsset, recipient)`**

1. Calls `TokenBridge.transferTokens()` — slow path, recipient = BasejumpLanding on dest chain.
2. Calls `wormhole.publishMessage()` with **consistency level 200** — encodes `sourceAsset`, `destAsset`, `netAmount` (amount after fee), and `recipient`.

**`completeTransfer(vaa)`** — receives fast-path VAA, dispatches via `XcmTransactor` to BasejumpLanding on Hydration.

### `BasejumpLanding` — Instant Delivery

Chain-agnostic transfer contract. Only callable by authorized bridge contracts. Delivers tokens to the recipient instantly using available liquidity.

**`completeTransfer(vaa)`**

- Decodes VAA payload: `(sourceAsset, destAsset, amount, recipient)`
- Validates `allowedAssetPairs[sourceAsset][destAsset]` — owner-managed whitelist of valid source→dest asset mappings
- Delivers `destAsset` tokens to the recipient immediately

**Settlement — automatic via TokenBridge**

- `bridgeViaWormhole()` sets the TokenBridge recipient to the BasejumpLanding contract address
- When the slow transfer finalizes (~13 min), relayer calls `TokenBridge.completeTransfer()` and tokens land directly in BasejumpLanding's balance
- No explicit `settle()` needed — the pool replenishes itself

**Custom implementations per chain:**

| Chain                 | BasejumpLanding Strategy                                  |
| --------------------- | ------------------------------------------------------- |
| Simple (any EVM)      | Direct transfer from pre-funded pool                    |
| Aave-supported chains | Flash-loan or borrow from Aave, repay on settlement     |
| Hydration             | Borrow from Hydration money market (Omnipool / lending) |
| Solana (Kamino)       | Borrow via Kamino, repay on settlement                  |

The key insight: BasejumpLanding doesn't know or care _how_ the bridge works. It just receives authorized `transfer()` calls and fulfills them using whatever liquidity strategy makes sense for that chain.

## Flow

See [schema.md](schema.md) for full architecture diagrams (both EVM → Hydration and Hydration → EVM directions).

## Interface

- [IBasejump.sol](../../platforms/evm/contracts/src/interfaces/IBasejump.sol)
- [IBasejumpLanding.sol](../../platforms/evm/contracts/src/interfaces/IBasejumpLanding.sol)

## Key Design Decisions

1. **Separation of concerns** — Basejump handles transport, BasejumpLanding handles delivery. Either can be upgraded or replaced independently.
2. **Moonbeam as thin proxy** — Moonbeam only verifies VAAs and dispatches XCM to Hydration. Holds no funds, no liquidity risk.
3. **BasejumpLanding authorization** — only whitelisted bridge contracts can call `transfer()`. Owner manages the whitelist. This is the security boundary.
4. **Auto-settlement** — TokenBridge recipient is set to BasejumpLanding address. Tokens arrive directly when the slow transfer completes. Pool balance is the accounting.
5. **Fee** — Basejump deducts a per-asset fee (`assetFee[asset]`) from the transfer amount before encoding the fast-path message. TokenBridge sends the full `amount` (slow settlement), but the instant message encodes `amount - fee`. BasejumpLanding delivers the net amount; the fee accrues as surplus in BasejumpLanding's balance when the slow settlement arrives.
6. **Future-proof transport** — want to switch from Wormhole to Snowbridge? Deploy a new bridge contract, authorize it on BasejumpLanding, done. BasejumpLanding doesn't change.
7. **Timeout / bad debt** — if slow transfer never arrives, BasejumpLanding needs a fallback. Options: governance clawback, insurance fund, or relayer bond.

## How Existing Contracts Map

| Contract          | Role                                                              |
| ----------------- | ----------------------------------------------------------------- |
| `MessageReceiver` | Base — VAA verification, replay protection, emitter authorization |
| `XcmTransactor`   | SCALE-encodes evm.call and dispatches via XCM to Hydration        |
