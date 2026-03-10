# Instant Bridging v2 — "InstaBridge + InstaLoan"

## The Problem

Same as v1: Standard Wormhole Token Bridge transfers require waiting for full guardian finality (~13 min on Ethereum). Users want tokens on the destination chain _now_.

## What Changed from v1

v1 assumed a fixed three-hop path (EVM → Moonbeam proxy → Hydration) with a single liquidity pool on Hydration. v2 decouples **transport** from **lending** into two independent contracts deployed on every chain, making the system chain-agnostic and composable.

## Architecture

Two contracts, deployed independently on every supported chain:

### `InstaBridge` — Transport + Messaging

Handles the bridge mechanics: initiating transfers and relaying verified messages. Can be swapped out for a different transport layer without touching InstaLoan.

**`bridgeViaWormhole(destChain, recipient, token, amount)`**

1. Calls `TokenBridge.transferTokens()` — the normal slow path (settles eventually)
2. Calls `wormhole.publishMessage()` with **consistency level 200 (instant finality)** — a fast signal containing transfer metadata:
   - `bridgeType` — which bridge was used (determines dest asset derivation logic)
   - `sourceToken` — asset address on source chain
   - `amount` — transfer amount
   - `recipient` — final receiver address
   - `sourceChain` — origin chain ID
   - `transferSequence` — bridge-specific sequence/nonce (not needed for POC, but useful for correlating instant loans with slow settlements for dispute resolution / bad debt tracking later)

**`completeTransfer(vaa)`**

1. Off-chain relayer picks up the instant-finality VAA (within seconds)
2. Relayer calls `completeTransfer(vaa)` on the destination chain's InstaBridge
3. InstaBridge verifies the VAA (parseAndVerifyVM, replay protection, authorized emitter checks)
4. Decodes metadata, derives the destination asset from `(bridgeType, sourceChain, sourceToken)`, and calls `InstaLoan.loan(recipient, destAsset, amount)`

### `InstaLoan` — Lending / Liquidity

Chain-agnostic lending contract. Only callable by authorized bridge contracts. Holds or sources liquidity to give users instant access to funds.

**`loan(recipient, token, amount)`**

- Called by an authorized InstaBridge (or any future authorized bridge)
- Delivers tokens to the recipient immediately

**Settlement — automatic via TokenBridge**

- `bridgeViaWormhole()` sets the TokenBridge recipient to the InstaLoan contract address
- When the slow transfer finalizes (~13 min), relayer calls `TokenBridge.completeTransfer()` and tokens land directly in InstaLoan's balance
- No explicit `settle()` needed — the pool replenishes itself

**Custom implementations per chain:**

| Chain                 | InstaLoan Strategy                                      |
| --------------------- | ------------------------------------------------------- |
| Simple (any EVM)      | Direct transfer from pre-funded pool                    |
| Aave-supported chains | Flash-loan or borrow from Aave, repay on settlement     |
| Hydration             | Borrow from Hydration money market (Omnipool / lending) |
| Solana (Kamino)       | Borrow via Kamino, repay on settlement                  |

The key insight: InstaLoan doesn't know or care _how_ the bridge works. It just receives authorized `loan()` calls and fulfills them using whatever liquidity strategy makes sense for that chain.

### Asset Resolution — Deterministic, No Registry

Destination assets are **derived deterministically** per bridge type — no manual mapping or on-chain registry needed:

- **Wormhole**: wrapped token address derived from `(sourceChain, sourceTokenAddress)` — TokenBridge attestation creates a deterministic wrapped token on the dest chain
- **Snowbridge**: XCM multilocation built from source asset address + Ethereum consensus info (`GlobalConsensus(Ethereum), AccountKey20(sourceToken)`)

InstaBridge's `completeTransfer` reads `bridgeType` from the VAA payload and calls the corresponding derivation function to resolve `destAsset` before passing it to `InstaLoan.loan()`. Pure logic, no state.

## Flow

```
Chain A (source)                                     Chain B (destination)
┌─────────────────────────┐                          ┌─────────────────────────┐
│ InstaBridge             │                          │ InstaBridge             │
│                         │                          │                         │
│ 1. TokenBridge          │                          │                         │
│    .transferTokens()    │                          │                         │
│    (slow, ~13min)       │                          │                         │
│                         │    instant VAA (~2s)     │                         │
│ 2. wormhole             │ ──────────────────────→  │ 3. completeTransfer()   │
│    .publishMessage()    │    relayer picks up      │    verify VAA           │
│    (finality=200)       │                          │    decode metadata      │
│                         │                          │                         │
└─────────────────────────┘                          │ 4. call InstaLoan       │
                                                     │    .loan()              │
                                                     └───────────-┬────────────┘
                                                                  │
                                                     ┌────────────▼────────────┐
                                                     │ InstaLoan               │
                                                     │                         │
                                                     │ 5. Deliver tokens to    │
                                                     │    recipient instantly  │
                                                     │    (pool / aave / mm)   │
                                                     │                         │
                                                     │          ...            │
                                                     │                         │
                                                     │ 6. TokenBridge          │
                                                     │    .completeTransfer()  │
                                                     │    tokens land directly │
                                                     │    in InstaLoan balance │
                                                     └─────────────────────────┘
```

## Contract Relationships

```
┌─────────────┐     authorized      ┌─────────────-┐
│ InstaBridge │ ──────────────────→ │  InstaLoan   │
│ (transport) │    .loan() calls    │  (liquidity) │
└─────────────┘                     └──────────────┘
       │                                    │
       │ can be replaced with               │ can have custom impl
       │ any transport layer                │ per chain
       │ (Wormhole, Sig, ...)               │
       │                                    │
       ▼                                    ▼
  Transport concern                   Liquidity concern
  (bridge + message)                  (lend + receive)
```

## Why This Is Better Than v1

1. **No Moonbeam proxy** — direct chain-to-chain. No intermediate hop needed for VAA verification (every chain can verify Wormhole VAAs natively).
2. **Separation of concerns** — InstaBridge handles transport, InstaLoan handles lending. Either can be upgraded or replaced independently.
3. **Multi-chain by default** — deploy InstaLoan + InstaBridge on any chain pair. Not locked to a single EVM → Moonbeam → Hydration path.
4. **Composable lending** — InstaLoan can plug into existing money markets (Aave, Kamino, Hydration Omnipool) instead of requiring its own liquidity pool. Less capital needed.
5. **Future-proof transport** — want to switch from Wormhole to LayerZero? Deploy a new bridge contract, authorize it on InstaLoan, done. InstaLoan doesn't change.

## How Existing Contracts Map

| Existing          | New Role                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `MessageEmitter`  | Base for InstaBridge source-side (publishMessage with finality=200)                                   |
| `MessageReceiver` | Base for InstaBridge dest-side (VAA verification, replay protection, authorized emitters)             |
| `XcmTransactor`   | Only needed if Hydration is the destination (InstaBridge on Moonbeam dispatches to Hydration via XCM) |

## Key Design Decisions

1. **InstaLoan authorization** — only whitelisted bridge contracts can call `loan()`. Owner manages the whitelist. This is the security boundary.
2. **Auto-settlement** — TokenBridge recipient is set to InstaLoan address. Tokens arrive directly when the slow transfer completes. Pool balance is the accounting.
3. **Custom InstaLoan impls** — base contract defines the interface (`loan`). Chain-specific implementations inherit and override liquidity sourcing.
4. **Fee model** — fee taken at loan time (e.g., 0.1% of amount). Goes to liquidity providers / protocol.
5. **Timeout / bad debt** — if slow transfer never arrives, InstaLoan needs a fallback. Options: governance clawback, insurance fund, or relayer bond.
6. **Token scope** — start with USDC. Expand to wrapped natives and other stables.

## POC Scope

- Two contracts: `InstaBridge` (extends MessageEmitter + MessageReceiver patterns), `InstaLoan` (new)
- Single token (USDC)
- Path: any EVM ↔ any EVM (simplest case, no XCM needed)
- InstaLoan: simple pre-funded pool strategy (no Aave/Kamino integration yet)
- Trusted single relayer
- Fixed fee (e.g., 0.1%)
- No timeout logic — happy path only
- Settlement: relayer redeems TokenBridge transfer, tokens land directly in InstaLoan

## Interface Sketch

```solidity
// InstaBridge — deployed on every chain
interface IInstaBridge {
    function bridgeViaWormhole(
        uint16 destChain,
        bytes32 recipient,
        address token,
        uint256 amount
    ) external payable;

    function completeTransfer(bytes memory vaa) external;
}

// InstaLoan — deployed on every chain
interface IInstaLoan {
    function loan(
        address recipient,
        address token,
        uint256 amount
    ) external;  // only authorized bridges
}
// Settlement: TokenBridge.completeTransfer() sends tokens directly to InstaLoan — no settle() needed
```
