# Basejump Schema

Two-rail data flow, wire format, and contract relationships. Design rationale lives in
[spec.md](spec.md).

## Ethereum → Hydration

Both rails leave the same transaction. The fast one pays the user in ~2 min; the slow one replenishes
the pool it was paid from, ~13 min later.

```
A: Ethereum (source)            Relay (off-chain)          B: Hydration (dest)
┌──────────────────────────┐   ┌──────────────────┐       ┌──────────────────────────┐
│ BasejumpEmitter          │   │                  │       │ BasejumpReceiver         │
│                          │   │                  │       │ (verify + route)         │
│ bridgeViaWormhole:       │   │                  │       │                          │
│                          │   │                  │       │                          │
│ 1. nttManagerFor[asset]  │   │                  │       │                          │
│    .transfer(GROSS, 73,  │   │                  │       │                          │
│      landing)            │   │                  │       │                          │
│    shouldQueue = false   │   │                  │       │                          │
│    (slow, ~13 min)       │   │                  │       │                          │
│            │             │   │                  │       │                          │
│            │ must succeed│   │                  │       │                          │
│            ▼ first       │   │                  │       │                          │
│ 2. wormhole              │   │                  │       │                          │
│    .publishMessage(      │──→│ 3. pick up       │       │                          │
│      TransferPayload,    │   │    instant VAA   │       │                          │
│      consistency = 200)  │   │    (~2 s)        │       │                          │
│    amount = NET          │   │                  │       │                          │
│                          │   │ 4. submit to     │       │                          │
└──────────────────────────┘   │    Hydration     │──────→│ 5. completeTransfer(vaa) │
                               │                  │       │    parseAndVerifyVM      │
                               │  relayer/basejump│       │    replay check          │
                               └──────────────────┘       │    emitter auth          │
                                                          │    decode payload        │
                                                          │            │             │
                                                          └────────────┼─────────────┘
                                                                       │ same chain
                                                                       ▼
                                                          ┌──────────────────────────┐
                                                          │ BasejumpLanding          │
                                                          │ (holds liquidity)        │
                                                          │                          │
                                                          │ 6. transfer(sourceAsset, │
                                                          │      NET, recipient)     │
                                                          │    destAssetFor[...]     │
                                                          │                          │
                                                          │ 7. balance sufficient?   │
                                                          │    yes → 0x0401 dispatch │
                                                          │          currencies      │
                                                          │          .transfer       │
                                                          │    no  → queue FIFO      │
                                                          │          (fulfillPending)│
                                                          │                          │
                                                          │          ...             │
                                                          │                          │
                                                          │ 8. NTT settlement lands  │
                                                          │    GROSS into the pool   │
                                                          │    → fee = GROSS − NET   │
                                                          │      accrues here        │
                                                          └──────────────────────────┘
```

The settlement rail is delivered by the relayer's `ntt` app, which carries the USDC route; the fast
rail by its `basejump` app — see [spec.md](spec.md#relaying).

## Atomicity

```
   completeTransfer(vaa)
        │
        ├─ parseAndVerifyVM ────────── fail ──► revert, VAA unconsumed
        ├─ processedVaas[hash]? ────── seen ──► revert
        ├─ authorizedEmitters[chain] ─ no ────► revert
        │
        ├─ processedVaas[hash] = true
        │
        └─ landing.transfer(...)
                 │
                 ├─ pool sufficient ──► 0x0401 dispatch ──► recipient credited
                 │
                 ├─ pool short ───────► queued, VAA CONSUMED
                 │                       (drain with fulfillPending)
                 │
                 └─ reverts ──────────► whole tx unwinds,
                                        processedVaas[hash] back to false,
                                        relay retries
```

Both ends of the delivery are on one chain, so there is no state where the VAA is consumed but the
funds never moved — except the deliberate one: a **shortfall queues and consumes**. That is the case
to alarm on (`pendingTail - pendingHead > 0`), because nothing drains the queue automatically.

## Wire format

`abi.encode(TransferPayload)` — dynamic, because `data` is `bytes`.

```
TransferPayload {
    address sourceAsset;       // asset pulled on the source chain
    uint256 amount;            // NET: gross − assetFee[sourceAsset]
    bytes32 recipient;         // AccountId32 on Hydration
    uint64  transferSequence;  // NTT manager sequence of the settlement leg
    bytes   data;              // opaque; forwarded untouched to the landing (inbound-intent channel)
}
```

`transferSequence` is the correlation key between the two rails: it is the NTT **manager's** message
sequence, not a Wormhole sequence and not chain-global. The indexer joins on it.

`amount` is net and the settlement is gross — the fee is the difference, and it lands in the pool
when the settlement arrives.

## Contract relationships

```
Ethereum                               Hydration
────────                               ─────────

┌──────────────────┐                   ┌──────────────────┐
│ BasejumpEmitter  │                   │ BasejumpReceiver │
│ (UUPS)           │                   │ (MessageReceiver)│
│                  │                   │                  │
│ landing ─────────┼── must equal ─────┼─► landing        │
│ nttManagerFor[]  │   (invariant 1,   │                  │
│ assetFee[]       │    unchecked!)    │                  │
└──────────────────┘                   └────────┬─────────┘
                                                │ authorized
                                                ▼
                                       ┌──────────────────┐
                                       │ BasejumpLanding  │
                                       │ (liquidity)      │
                                       │                  │
                                       │ authorizedBridge │
                                       │ destAssetFor[]   │
                                       │ pending FIFO     │
                                       └──────────────────┘
```

Neither end inherits the other. They share exactly one thing — `IBasejumpPayload` — so the emitter
has no receive path and the receiver has no send path, enforced by the compiler rather than by
configuration.

`BasejumpLanding` knows nothing about the transport: it takes authorized `transfer()` calls and
fulfils them from whatever liquidity strategy suits its chain. Swapping the transport means
deploying a new bridge contract and authorizing it; the landing does not change.

## Landing strategies

The pre-funded pool is the V1 strategy, not the only possible one:

| Chain          | Strategy                                        |
| -------------- | ----------------------------------------------- |
| Hydration (V1) | Pre-funded pool, `0x0401` dispatch for delivery |
| Any EVM        | Direct ERC20 transfer from a pre-funded pool    |
