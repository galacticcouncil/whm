# Insta Bridge Schema

## EVM → Hydration (via Moonbeam MRL)

```
A: Source EVM               Relayer (off-chain)         B: Moonbeam (proxy)              C: Hydration (dest)
┌──────────────────────┐   ┌──────────────────┐       ┌──────────────────────────┐     ┌──────────────────────────┐
│ InstaBridge          │   │                  │       │ InstaBridgeProxy         │     │ InstaTransfer            │
│                      │   │                  │       │ (no funds, just routing) │     │ (holds liquidity)        │
│                      │   │                  │       │                          │     │                          │
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
                                                      │    .transact()           │────→│ 7. transfer(recipient,   │
                                                      │                          │     │      asset, amount)      │
                                                      │    → InstaTransfer       │     │                          │
                                                      │        .transfer()       │     │                          │
                                                      │                          │     │                          │
                                                      └──────────────────────────┘     │ 8. Deliver tokens to     │
                                                                                       │    recipient instantly   │
                                                                                       │                          │
                                                                                       │          ...             │
                                                                                       │                          │
                                                                                       │ 9. Slow TokenBridge      │
                                                                                       │    transfer finalizes    │
                                                                                       │    → tokens land in      │
                                                                                       │    InstaTransfer balance │
                                                                                       └──────────────────────────┘
```

## Hydration → EVM (via Moonbeam Wormhole)

```
A: Hydration (source)       B: Moonbeam (proxy)              Relayer (off-chain)         C: Dest EVM
┌──────────────────────┐   ┌──────────────────────────┐     ┌──────────────────┐       ┌──────────────────────────┐
│ User / dApp          │   │ InstaBridgeProxy         │     │                  │       │ InstaBridge              │
│                      │   │                          │     │                  │       │                          │
│ 1. XCM transfer      │   │                          │     │                  │       │                          │
│    asset to Moonbeam │   │                          │     │                  │       │                          │
│    → bridgeViaWorm   │   │                          │     │                  │       │                          │
│      hole()          │──→│                          │     │                  │       │                          │
│                      │   │                          │     │                  │       │                          │
└──────────────────────┘   │ 2. TokenBridge           │     │                  │       │                          │
                           │    .transferTokens()     │     │                  │       │                          │
                           │    (slow, ~13min)        │     │                  │       │                          │
                           │    recipient =           │     │                  │       │                          │
                           │    InstaTransfer on dest │     │                  │       │                          │
                           │                          │     │                  │       │                          │
                           │ 3. wormhole              │     │                  │       │                          │
                           │    .publishMessage()     │────→│ 4. Pick up       │       │                          │
                           │    (finality=200)        │     │    instant VAA   │       │                          │
                           │                          │     │    (~2s)         │       │                          │
                           └──────────────────────────┘     │                  │       │                          │
                                                            │ 5. Submit VAA    │       │                          │
                                                            │    to dest EVM   │──────→│ 6. completeTransfer()    │
                                                            │                  │       │    verify VAA            │
                                                            └──────────────────┘       │    decode metadata       │
                                                                                       │                          │
                                                                                       │ 7. InstaTransfer         │
                                                                                       │    .transfer(recipient,  │
                                                                                       │      asset, amount)      │
                                                                                       │                          │
                                                                                       │ 8. Deliver tokens to     │
                                                                                       │    recipient instantly   │
                                                                                       │                          │
                                                                                       │          ...             │
                                                                                       │                          │
                                                                                       │ 9. Slow TokenBridge      │
                                                                                       │    transfer finalizes    │
                                                                                       │    → tokens land in      │
                                                                                       │    InstaTransfer balance │
                                                                                       └──────────────────────────┘
```

## Contract Relationships

```
┌─────────────┐     authorized          ┌──────────────────┐
│ InstaBridge │ ──────────────────→     │  InstaTransfer   │
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
