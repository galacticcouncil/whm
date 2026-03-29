# Instant Bridging v2 — "Basejump + BasejumpLanding"

## The Problem

Standard Wormhole Token Bridge transfers require waiting for full guardian finality (~13 min on Ethereum). Users want tokens on the destination chain _now_.

## Overview

Two independent contracts — **Basejump** (transport) and **BasejumpLanding** (delivery) — deployed on every supported chain. Transport is decoupled from delivery, making the system chain-agnostic and composable.

## Architecture

Three contracts, sharing a common base (`BasejumpBase`):

### `BasejumpBase` — Shared Logic (abstract)

Common storage (`tokenBridge`, `emitterNonce`, `basejumpLandings`, `feeBps`), VAA verification (`completeTransfer` → `receiveMessage` → `_processMessage`), fee calculation (`quoteFee`). Subclasses implement `bridgeViaWormhole` (outbound) and `_executeTransfer` (inbound).

### `Basejump` — Source EVM Chains (Base, Ethereum, etc.)

Bridges funds **into** Hydration via Moonbeam GMP (MRL).

**`bridgeViaWormhole(asset, amount, destChain, destAsset, recipient)`**

1. Calls `TokenBridge.transferTokensWithPayload()` — slow path via MRL. Recipient is Moonbeam GMP precompile (`0x816`), payload is SCALE-encoded `VersionedUserAction::V1` pointing to BasejumpLanding on Hydration (parachain 2034).
2. Calls `wormhole.publishMessage()` with **consistency level 200 (instant finality)** — encodes `destAsset`, `netAmount` (amount after 0.1% fee), and `recipient`.

**`completeTransfer(vaa)`** — receives fast-path VAA, calls `BasejumpLanding.transfer()` directly on the same chain.

### `BasejumpProxy` — Moonbeam (Hydration Proxy)

Bridges funds **out** from Hydration to external Wormhole chains.

**`bridgeViaWormhole(asset, amount, destChain, destAsset, recipient)`**

1. Calls `TokenBridge.transferTokens()` — slow path, recipient = BasejumpLanding on dest chain.
2. Calls `wormhole.publishMessage()` with **consistency level 200** — encodes `destAsset`, `netAmount` (amount after fee), and `recipient`.

**`completeTransfer(vaa)`** — receives fast-path VAA, dispatches via `XcmTransactor` to BasejumpLanding on Hydration.

### `BasejumpLanding` — Instant Delivery

Chain-agnostic transfer contract. Only callable by authorized bridge contracts. Delivers tokens to the recipient instantly using available liquidity.

**`transfer(recipient, token, amount)`**

- Called by an authorized Basejump (or any future authorized bridge)
- Delivers tokens to the recipient immediately

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

### Asset Resolution — Caller-Provided

The `destAsset` is specified by the consumer when calling `bridgeViaWormhole()`. It gets encoded into the instant message payload and forwarded all the way to `BasejumpLanding.transfer()` on the destination chain. No on-chain derivation or registry needed — the off-chain layer (SDK/frontend) resolves the correct dest asset address based on the bridge type (Wormhole wrapped address, Snowbridge asset ID, etc.) and passes it in.

## Flow

```
A: Source EVM               Relayer (off-chain)         B: Moonbeam (proxy)              C: Hydration (dest)
┌──────────────────────┐   ┌──────────────────┐       ┌──────────────────────────┐     ┌──────────────────────────┐
│ Basejump          │   │                  │       │ Basejump              │     │ BasejumpLanding            │
│                      │   │                  │       │ (no funds, just routing) │     │ (holds liquidity)        │
│ 1. TokenBridge       │   │                  │       │                          │     │                          │
│    .transferTokens() │   │                  │       │                          │     │                          │
│    (slow, ~13min)    │   │                  │       │                          │     │                          │
│                      │   │                  │       │                          │     │                          │
│ 2. wormhole          │   │                  │       │                          │     │                          │
│    .publishMessage() │──→│ 3. Pick up       │       │                          │     │                          │
│    (finality=200)    │   │    instant VAA   │       │                          │     │                          │
│                      │   │    (~2s)         │       │                          │     │                          │
└──────────────────────┘   │                  │       │                          │     │                          │
                           │ 4. Submit VAA    │       │                          │     │                          │
                           │    to Moonbeam   │──────→│ 5. completeTransfer()    │     │                          │
                           │                  │       │    verify VAA            │     │                          │
                           └──────────────────┘       │    decode metadata       │     │                          │
                                                      │                          │     │                          │
                                                      │ 6. XcmTransactor         │ XCM │                          │
                                                      │    .transact()           │────→│ 7. transfer(recipient,   |
                                                      │                          |     |      asset, amount)      |
                                                      │    → BasejumpLanding       |     |                          |
                                                      |        .transfer()│      │     |                          │
                                                      │                          │     │                          │
                                                      └──────────────────────────┘     │ 8. Deliver tokens to     │
                                                                                       │    recipient instantly   │
                                                                                       │                          │
                                                                                       │          ...             │
                                                                                       │                          │
                                                                                       │ 9. Slow TokenBridge      │
                                                                                       │    transfer finalizes    │
                                                                                       │    → tokens land in      │
                                                                                       │    BasejumpLanding balance │
                                                                                       └──────────────────────────┘
```

## Contract Relationships

```
┌─────────────┐     authorized          ┌─────────────-────┐
│ Basejump │ ──────────────────→     │  BasejumpLanding   │
│ (transport) │    .transfer() calls    │  (liquidity)     │
└─────────────┘                         └──────────────────┘
       │                                    │
       │ can be replaced with               │ can have custom impl
       │ any transport layer                │ per chain
       │ (Wormhole, Sig, ...)               │
       │                                    │
       ▼                                    ▼
  Transport concern                   Liquidity concern
  (bridge + message)                  (deliver + receive)
```

## Key Benefits

1. **Separation of concerns** — Basejump handles transport, BasejumpLanding handles delivery. Either can be upgraded or replaced independently.
2. **Moonbeam as thin proxy** — Moonbeam only verifies VAAs and dispatches XCM to Hydration. Holds no funds, no liquidity risk.
3. **Composable delivery** — BasejumpLanding can plug into existing money markets (Aave, Kamino, Hydration Omnipool) instead of requiring its own liquidity pool. Less capital needed.
4. **Future-proof transport** — want to switch from Wormhole to Snowbridge? Deploy a new bridge contract, authorize it on BasejumpLanding, done. BasejumpLanding doesn't change.
5. **Caller-provided asset resolution** — `destAsset` specified upfront by consumer. No on-chain derivation or registry. SDK/frontend handles the mapping per bridge type.

## How Existing Contracts Map

| Existing          | New Role                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `MessageEmitter`  | Base for Basejump source-side (publishMessage with finality=200)                                   |
| `MessageReceiver` | Base for Basejump dest-side (VAA verification, replay protection, authorized emitters)             |
| `XcmTransactor`   | Only needed if Hydration is the destination (Basejump on Moonbeam dispatches to Hydration via XCM) |

## Key Design Decisions

1. **BasejumpLanding authorization** — only whitelisted bridge contracts can call `transfer()`. Owner manages the whitelist. This is the security boundary.
2. **Auto-settlement** — TokenBridge recipient is set to BasejumpLanding address. Tokens arrive directly when the slow transfer completes. Pool balance is the accounting.
3. **Custom BasejumpLanding impls** — base contract defines the interface (`transfer`). Chain-specific implementations inherit and override liquidity sourcing.
4. **Fee** — Basejump deducts 0.1% (10 bps, configurable via `feeBps`) from the transfer amount before encoding the fast-path message. TokenBridge sends the full `amount` (slow settlement), but the instant message encodes `amount - fee`. BasejumpLanding delivers the net amount; the fee accrues as surplus in BasejumpLanding's balance when the slow settlement arrives.
5. **Timeout / bad debt** — if slow transfer never arrives, BasejumpLanding needs a fallback. Options: governance clawback, insurance fund, or relayer bond.

## POC Scope

- Three contracts: `Basejump` (source EVMs, MRL), `BasejumpProxy` (Moonbeam, XCM), `BasejumpLanding` (new)
- Single token (USDC)
- Paths: Source EVM → Moonbeam GMP (MRL) → Hydration, Hydration → Moonbeam → Dest EVM (Wormhole)
- BasejumpLanding: simple pre-funded pool strategy (no Aave/Kamino integration yet)
- Trusted single relayer
- No timeout logic — happy path only
- Settlement: relayer redeems TokenBridge transfer, tokens land directly in BasejumpLanding

## Interface Sketch

```solidity
// Basejump — deployed on every chain
interface IBasejump {
    function bridgeViaWormhole(
        address asset,
        uint256 amount,
        uint16 destChain,
        address destAsset,
        bytes32 recipient
    ) external payable returns (uint64 transferSequence, uint64 messageSequence);

    function completeTransfer(bytes memory vaa) external;

    function quoteFee(uint256 amount) external view returns (uint256 fee);
}

// BasejumpLanding — deployed on every chain
interface IBasejumpLanding {
    function transfer(
        address asset,
        uint256 amount,
        address recipient
    ) external;  // only authorized bridges
}
// Settlement: TokenBridge.completeTransfer() sends tokens directly to BasejumpLanding — no settle() needed
// Fee: Basejump deducts feeBps (default 10 = 0.1%) from amount in the fast-path message
```
