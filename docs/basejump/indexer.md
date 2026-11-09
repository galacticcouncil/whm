# Basejump Indexer Spec

Event reference for the Basejump corridor. The indexer that consumes these is
[`scan`](../scan/spec.md); the corridor itself is [spec.md](spec.md).

## Overview

Basejump delivers tokens instantly from a pre-funded pool on the destination while an NTT settlement
replenishes that pool in the background (~13 min). Two chains per corridor: the source EVM and
Hydration.

## Chains & contracts

| Chain     | Contract          | Notes                                                  |
| --------- | ----------------- | ------------------------------------------------------ |
| Base      | `BasejumpEmitter` | emits `BridgeInitiated`                                |
| Hydration | `BasejumpReceiver` | emits `TransferProcessed`                              |
| Hydration | `BasejumpLanding` | `0x70e9b12c3b19cb5f0e59984a5866278ab69df976` — delivery |

More source chains will be added with the same interfaces and event signatures. The receiver and the
landing are shared across corridors — one Hydration deployment serves every source.

## Events to index

### Source — `BasejumpEmitter`

**`BridgeInitiated`** — a transfer started.

```solidity
event BridgeInitiated(
    address indexed asset,     // source token address
    uint256 amount,            // GROSS amount (before fee)
    uint256 fee,               // fee withheld from the fast leg
    uint16 destChain,          // Wormhole destination chain id (73)
    bytes32 recipient,         // destination recipient
    uint64 transferSequence,   // NTT manager sequence — the settlement leg
    uint64 messageSequence     // Wormhole sequence — the fast-path message
)
```

`transferSequence` is the NTT **manager's** message sequence, not a Wormhole sequence and not
chain-global. See the [indexer note](spec.md#adding-a-token) on keying by it.

### Destination — `BasejumpReceiver` (Hydration)

**`TransferProcessed`** — fast-path VAA verified and forwarded to the landing.

```solidity
event TransferProcessed(
    address indexed sourceAsset,
    uint256 amount,            // NET
    bytes32 indexed recipient
)
```

### Destination — `BasejumpLanding` (Hydration)

**`TransferExecuted`** — delivered to the recipient.

```solidity
event TransferExecuted(
    address indexed sourceAsset,
    address indexed destAsset,
    bytes32 indexed recipient,
    uint256 amount
)
```

**`TransferQueued`** — pool short, queued for later.

```solidity
event TransferQueued(
    uint256 indexed id,
    address indexed sourceAsset,
    address destAsset,
    bytes32 recipient,
    uint256 amount
)
```

**`PendingTransferFulfilled`** — queued transfer delivered once liquidity arrived (by
`fulfillPending()`, or by `parkPending()` when the head's dispatch succeeded).

```solidity
event PendingTransferFulfilled(
    uint256 indexed id,
    address indexed sourceAsset,
    address destAsset,
    bytes32 recipient,
    uint256 amount
)
```

**`TransferParked`** — `parkPending()` moved the queue head to `parkedTransfers`: the pool held its
amount but its dispatch failed (e.g. below the asset's existential deposit to an empty account).
Not paid; still reserved; the queue moves on behind it.

```solidity
event TransferParked(
    uint256 indexed id,
    address indexed sourceAsset,
    address destAsset,
    bytes32 recipient,
    uint256 amount
)
```

**`ParkedTransferFulfilled`** — `fulfillParked(id)` paid a parked transfer. Nothing calls it
automatically: a parked payout needs a human.

```solidity
event ParkedTransferFulfilled(
    uint256 indexed id,
    address indexed sourceAsset,
    address destAsset,
    bytes32 recipient,
    uint256 amount
)
```

## Transfer lifecycle

`TransferProcessed` and the landing's outcome event are emitted in the **same transaction** —
delivery is one atomic call on Hydration, so they never appear apart. Ordering:

1. `BridgeInitiated` on the source — transfer started
2. `TransferProcessed` on Hydration — fast-path VAA verified
3. `TransferExecuted` **or** `TransferQueued`, same tx as (2) — delivery outcome
4. (if queued) `PendingTransferFulfilled` — delivered after settlement replenished the pool, **or**
   `TransferParked` — moved off the head unpaid because its dispatch failed
5. (if parked) `ParkedTransferFulfilled` — delivered by `fulfillParked(id)`

All of 4 and 5 carry the queue `id` from `TransferQueued`, which is how they join (namespaced by
the landing's address).

A revert anywhere in (2)–(3) unwinds both, so a `TransferProcessed` without an outcome event in the
same transaction cannot happen. `TransferQueued` means the VAA is consumed and the payout waits on the pool; the `basejump`
relayer pays it (see the relayer README). `TransferParked` is the case to alarm on: nothing calls
`fulfillParked` automatically.

## Correlation

- **`transferSequence`** from `BridgeInitiated` — the NTT manager sequence, also the key carried in
  the fast-path payload. The strongest join.
- **`recipient`** (bytes32) — present in every event.
- **`sourceAsset`** + **`amount`** — note `BridgeInitiated.amount` is **gross**; every destination
  event carries **net** (`amount - fee`).

## Transfer states

| State       | Determined by                                    |
| ----------- | ------------------------------------------------ |
| `initiated` | `BridgeInitiated` seen                           |
| `processed` | `TransferProcessed` seen                         |
| `completed` | `TransferExecuted` seen                          |
| `queued`    | `TransferQueued` seen                            |
| `parked`    | `TransferParked` seen (after `queued`); outranks `queued`, status `held` |
| `fulfilled` | `PendingTransferFulfilled` or `ParkedTransferFulfilled` seen (after `queued`); outranks `parked` |

## Notes

- V1 supports one token per source: EURC (`0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` on Base).
- `recipient` is bytes32 — a left-zero-padded address on EVM, an AccountId32 on Hydration.
- `Withdrawn` and `DestAssetUpdated` on the landing are admin-only; ignore them for transfer
  indexing.
