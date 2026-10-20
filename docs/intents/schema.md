# SCHEMA — Intents

Companion to [spec.md](spec.md). Wire formats of the deployed rail.

---

## Message topology

Two messages leave the same Hydration transaction, read by the same Ethereum call.

```
                      HYDRATION                          ETHEREUM
                      ─────────                          ────────

  placeOrder(…, depositAddress, maxRelayFee)          ┌── IntentReceiver
    │                                                 │     .processOrder(B, C, fee)
    ├─► [B] NTT settlement ───────────────────────────┤       pair B↔C on the NTT
    │        emitter: WormholeTransceiver             │       manager sequence
    │        payload: NTT transfer (no room for us)   │            │
    │        carries: the value                       │            ▼
    │                                                 │     forward to depositAddress
    └─► [C] forwarding instruction ───────────────────┘            │
             emitter: IntentEmitter                                │  POA watcher
             payload: abi.encode(seq, depositAddress,              │  (not our tx)
                                 maxRelayFee)                      ▼
             carries: where the value goes                    the 1Click quote's
                                                              intents account credited
```

`IntentReceiver` pins the emitter it accepts instructions from (chain 73 + `IntentEmitter`'s
address); any other emitter reverts `UnauthorizedEmitter` before anything decodes.

## Three sequence counters, easily confused

```
  NttManager._useMessageSequence()   ← what transfer() returns, and what [C] names.
                                       NOT a Wormhole sequence.
  transceiver's Wormhole sequence    ← addresses [B].  Published with nonce 0,
                                       return value discarded on-chain.
  IntentEmitter's Wormhole sequence  ← addresses [C].
```

All three increment independently. `processOrder` re-derives the manager sequence from [B]'s payload
and requires it to equal the one [C] names — that check is what stops a caller pairing any pending
settlement with whichever instruction carries the richest ceiling.

---

## The forwarding instruction

Read on **Ethereum**, telling `IntentReceiver` where an order's funds go.

Plain `abi.encode`, not packed — the decoder is Solidity, and the bytes are never hashed:

```solidity
abi.encode(
    uint64  transferSequence,  // the NTT manager's sequence for the settlement it pairs with
    address depositAddress,    // where the receiver forwards
    uint256 maxRelayFee        // ceiling on what the caller may claim
)
```

Fixed 96 bytes, all static — no strings, so no length games:

```
 word   0                1                2
        ├────────────────┼────────────────┼────────────────┐
        │ transferSeq    │ depositAddress │  maxRelayFee   │
        │ u64, left-pad  │ addr, left-pad │     u256       │
        └────────────────┴────────────────┴────────────────┘
          32 bytes         32               32
```

Published from the same transaction as the settlement, so both land in one `LogMessagePublished`
sweep of the source receipt — which is how the relayer finds it:

```
  source tx receipt (Hydration)
  ┌──────────────────────────────────────────────────────────┐
  │ LogMessagePublished(sender = WormholeTransceiver, …)   ──► [B] settlement
  │ LogMessagePublished(sender = IntentEmitter,        …)  ──► [C] instruction
  └──────────────────────────────────────────────────────────┘
        │                                    │
        │ filter topics[1] == emitter        │ decode data → sequence, depositAddress,
        │                                    │               maxRelayFee
        ▼                                    ▼
   nothing to do here              match sequence against [B], then processOrder
```

`sender` is the only indexed field on `LogMessagePublished`, which is enough to pick our emitter's
messages out of a receipt without needing the core bridge's own address.

**Why `transferSequence` is the join key.** It is the NTT **manager's** message sequence, returned by
`NttManager.transfer` and written into the manager message as `bytes32(uint256(sequence))`. It is
_not_ a Wormhole sequence: the settlement VAA is addressed by the transceiver's Wormhole sequence and
the instruction by the emitter's, and those are three independent counters. `processOrder` re-derives
the manager sequence from the settlement payload and rejects a mismatch, which is what stops a caller
pairing any pending settlement with whichever instruction carries the richest ceiling.

**Why `amount` is read from the settlement rather than carried.** The receiver walks into the NTT
transfer body for it — `NttPayload.settlementOf` returns it off the same pass that yields the
sequence and the digest preimage. That makes the number it forwards the number the rail released, so
an instruction has no size to over-state and there is no divergence to check for. It costs ~517 gas
against carrying it, and saves 32 bytes of instruction. The amount arrives trimmed to 8 decimals;
any other precision reverts `UnexpectedTrim` rather than being scaled by a guess.

**Delivered is not released.** `processOrder` cannot infer that funds arrived from the settlement
having been delivered. NTT's inbound rate limiter consumes the VAA and marks the manager message
executed *before* it decides whether to release, so a rate-limited transfer is queued and credits
nothing while `isVAAConsumed` reads true. The receiver therefore asks the manager directly —
`isMessageExecuted(digest) && getInboundQueuedTransfer(digest).txTimestamp == 0` — and reverts
`SettlementNotReleased` otherwise, on top of the balance check. The digest is
`keccak256(abi.encodePacked(sourceChainId, managerMessage))`, where `managerMessage` is the slice
`NttPayload` already walks past.

| `isMessageExecuted` | `txTimestamp` | state |
| --- | --- | --- |
| false | 0 | never delivered or attested |
| true | 0 | released |
| true | ≠ 0 | queued — nothing credited |
| true | 0 | queued, then completed — released |

**Consistency level.** Published finalized (202), matching the settlement leg. The sequence the
instruction names is contract storage, so a reorg rewinds it — and a guardian signature is never
retracted. Signed pre-finality, the instruction would stay valid forever while pointing at whatever
transfer next took that counter. At 202 the guardian drops a message whose block disappears, in the
same `pending` loop that already protects the settlement, so the pair can be orphaned together but
never split.

This costs no latency. Chain 73's watcher does honour 200 — measured across 22 live orders, the
instruction was signed a median of 38s ahead of its settlement — but a relayer cannot act until the
settlement arrives, and that is 202 either way. The reorg window was that 38s.

---

## Constants

```
Hydration Wormhole chain id  73
Hydration core bridge        0x3792a6d63c31941B2805181771795D9176fA82A1
Ethereum Wormhole chain id   2
ETH (intents token id)       nep141:eth.omft.near
POA min deposit (eth:1)      100000000000            (1e11 wei)
```

Deployed addresses: [`deployments/prod/intent.json`](../../deployments/prod/intent.json).
