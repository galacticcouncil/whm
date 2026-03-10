# Instant Bridging POC — "Loan & Settle"

## The Problem

Standard Wormhole Token Bridge transfers require waiting for full guardian finality (~13 min on Ethereum). Users want tokens on the destination chain _now_.

## The Idea

Three contracts across the bridging path: EVM → Moonbeam (Wormhole) → Hydration (XCM)

**Source EVM chain — `InstantBridgeEmitter`** (extends MessageEmitter pattern)

1. User calls `bridgeTokens(destChain, recipient, amount)`
2. Contract calls `TokenBridge.transferTokens()` — the normal, slow path (this settles eventually)
3. Contract also calls `wormhole.publishMessage()` with **consistency level 200 (instant finality)** — a fast signal containing transfer details (token, amount, recipient, transferSequence)

**Moonbeam — `InstantBridgeProxy`** (extends MessageReceiver pattern)

1. Off-chain relayer picks up the instant-finality VAA within seconds
2. Relayer submits VAA to `receiveMessage(vaa)` on Moonbeam
3. Contract verifies VAA, then calls `XcmTransactor` to dispatch a transact call to Hydration's `InstantBridgeSettler` with the verified transfer details
4. Moonbeam holds no funds — acts purely as a VAA verification + XCM dispatch proxy

**Hydration — `InstantBridgeSettler`** (holds liquidity pool)

1. Receives XCM transact call from Moonbeam's `InstantBridgeProxy`
2. **Loans** tokens to recipient from a pre-funded liquidity pool
3. Later, when the slow TokenBridge transfer finalizes, the relayer redeems it and **replenishes** the pool on Hydration

## Flow

```
Source EVM                      Moonbeam (proxy only)               Hydration (holds funds)
┌────────────────────┐          ┌──────────────────────────┐       ┌───────────────────────┐
│ InstantBridge      │          │ InstantBridgeProxy       │       │ InstantBridge         │
│ Emitter            │          │ (no funds, just routing) │       │ Settler               │
│                    │          │                          │       │                       │
│ 1. Lock tokens via │ instant  │                          │       │                       │
│    TokenBridge     │── VAA ─→ | 3. Verify VAA            │       │                       │
│                    │ (~2s)    │                          │       │                       │
│ 2. Publish instant │          │ 4. Dispatch XCM transact │  XCM  │ 5. Loan tokens to     │
│    wormhole msg    │          │    to Hydration          │──────→│    recipient          |
|                    |          |                          |       |                       |
│                    |          |                          |       |                       |
│                    │          │                          │       │                       │
│                    │  slow    │                          │       │ 6. Relayer redeems    │
│                    │─redeem─→ | (passthrough)            │──────→│    TokenBridge        │
│                    │(~13min)  │                          │       │    → replenish pool   │
└────────────────────┘          └──────────────────────────┘       └───────────────────────┘
```

## Why Existing Contracts Already Solve Half of This

- **MessageEmitter** — already publishes with `consistencyLevel = 200` (instant). Just need to add the TokenBridge call alongside it and encode transfer metadata instead of a string.
- **MessageReceiver** — already has `receiveMessage(vaa)` with `parseAndVerifyVM`, authorized emitter checks, and replay protection via `processedVaas`. The Moonbeam proxy extends this and overrides `_processMessage` to dispatch XCM transact to Hydration instead of emitting an event.

## Key Design Decisions

1. **Liquidity pool on Moonbeam** — relayer/market maker pre-deposits tokens into the relay contract. Pool replenished when slow TokenBridge transfer settles.
2. **XcmTransactor integration** — the relay contract on Moonbeam needs to call `XcmTransactor.transactThroughSigned()` or similar to reach Hydration. XCM weight/fees need to be pre-configured.
3. **Hydration contract** — could be an EVM contract on Hydration (if EVM pallet available) or a Substrate pallet call target. POC assumes EVM on Hydration.
4. **Fee model** — relayer/LP takes a small fee for the instant service (compensates capital lockup + XCM fees).
5. **Race condition safety** — what if the slow transfer never arrives? Need a timeout or fallback mechanism.
6. **Token scope** — start with a single token (e.g., USDC) to keep the POC simple.

## POC Scope

- Single token (USDC or wrapped native)
- Path: EVM → Moonbeam (Wormhole) → Hydration (XCM)
- Trusted single relayer (no auction/competition)
- Fixed fee (e.g., 0.1%)
- Hydration side assumes EVM-compatible contract
- No timeout logic yet — assume happy path
