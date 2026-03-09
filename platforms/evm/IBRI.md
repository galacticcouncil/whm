# Instant Bridging POC — "Loan & Settle"

## The Problem

Standard Wormhole Token Bridge transfers require waiting for full guardian finality (~13 min on Ethereum). Users want tokens on the destination chain _now_.

## The Idea

Two wrapper contracts that sit on top of the existing Wormhole + TokenBridge infrastructure:

**Source chain — `InstantBridgeEmitter`** (extends MessageEmitter pattern)

1. User calls `bridgeTokens(destChain, recipient, amount)`
2. Contract calls `TokenBridge.transferTokens()` — the normal, slow path (this settles eventually)
3. Contract also calls `wormhole.publishMessage()` with **consistency level 200 (instant finality)** — a fast signal containing transfer details (token, amount, recipient, transferSequence)

**Destination chain — `InstantBridgeReceiver`** (extends MessageReceiver pattern)

1. Off-chain relayer picks up the instant-finality VAA within seconds
2. Relayer submits VAA to `receiveMessage(vaa)` — existing manual delivery path with `parseAndVerifyVM`
3. Contract verifies the VAA, then **loans** the tokens to the recipient from a pre-funded liquidity pool
4. Later, when the slow TokenBridge transfer finalizes, the relayer redeems it and **replenishes** the pool

## Flow

```
Source Chain                          Destination Chain
┌──────────────────────┐               ┌───────────────────────┐
│ InstantBridgeEmitter │               │ InstantBridgeReceiver │
│                      │               │                       │
│ 1. Lock tokens via   │   instant     │ 3. Verify instant     │
│    TokenBridge       │──── VAA ─────→│    VAA                │
│                      │   (~2 sec)    │                       │
│ 2. Publish instant   │               │ 4. Loan tokens to     │
│    wormhole message  │               │    recipient from     │
│                      │               │    liquidity pool     │
│                      │               │                       │
│                      │   slow redeem │ 5. Relayer redeems    │
│                      │───────────────│    TokenBridge        │
│                      │  (~13 min)    │    transfer →         │
│                      │               │    replenish pool     │
└──────────────────────┘               └───────────────────────┘
```

## Why Existing Contracts Already Solve Half of This

- **MessageEmitter** — already publishes with `consistencyLevel = 200` (instant). Just need to add the TokenBridge call alongside it and encode transfer metadata instead of a string.
- **MessageReceiver** — already has `receiveMessage(vaa)` with `parseAndVerifyVM`, authorized emitter checks, and replay protection via `processedVaas`. Just need to override `_processMessage` to release tokens from a pool instead of emitting an event.

## Key Design Decisions

1. **Liquidity pool** — who funds it? Simple approach: relayer/market maker pre-deposits tokens. The receiver contract holds the pool and only releases on valid VAAs.
2. **Fee model** — the relayer/LP takes a small fee for the instant service (compensates capital lockup risk).
3. **Race condition safety** — what if the slow transfer never arrives? Need a timeout or fallback mechanism.
4. **Token scope** — start with a single token (e.g., USDC) to keep the POC simple.

## POC Scope

- Single token (USDC or wrapped native)
- Trusted single relayer (no auction/competition)
- Fixed fee (e.g., 0.1%)
- No timeout logic yet — assume happy path
