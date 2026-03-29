# Basejump Schema

## EVM → Hydration (via Moonbeam MRL)

```
A: Source EVM               Relayer (off-chain)         B: Moonbeam (proxy)              C: Hydration (dest)
┌──────────────────────┐   ┌──────────────────┐       ┌──────────────────────────┐     ┌──────────────────────────┐
│ Basejump             │   │                  │       │ BasejumpProxy            │     │ BasejumpLanding          │
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
                                                      │    → BasejumpLanding     │     │                          │
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
                                                                                       │    BasejumpLanding bal.  │
                                                                                       └──────────────────────────┘
```

## Hydration → EVM (via Moonbeam Wormhole)

```
A: Hydration (source)       B: Moonbeam (proxy)              Relayer (off-chain)         C: Dest EVM
┌──────────────────────┐   ┌──────────────────────────┐     ┌──────────────────┐       ┌──────────────────────────┐
│ User / dApp          │   │ BasejumpProxy            │     │                  │       │ Basejump                 │
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
                           │    BasejumpLanding dest  │     │                  │       │                          │
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
                                                                                       │ 7. BasejumpLanding       │
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
                                                                                       │    BasejumpLanding bal.  │
                                                                                       └──────────────────────────┘
```

## Contract Relationships

```
┌─────────────┐     authorized          ┌──────────────────┐
│  Basejump   │ ──────────────────→     │ BasejumpLanding  │
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
