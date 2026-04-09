# Basejump Indexer Spec

## Overview

Basejump is a cross-chain bridging system that delivers tokens instantly using a fast-path message while a slow TokenBridge transfer settles in the background (~13 min). The indexer tracks transfer lifecycle across three chains.

## Chains & Contracts

| Chain     | Contract        | Address                                      |
| --------- | --------------- | -------------------------------------------- |
| Base      | Basejump        | `0xf5b9334e44f800382cb47fc19669401d694e529b` |
| Moonbeam  | BasejumpProxy   | `0xf5b9334e44f800382cb47fc19669401d694e529b` |
| Hydration | BasejumpLanding | `0x70e9b12c3b19cb5f0e59984a5866278ab69df976` |

More source chains will be added over time (same contract interfaces).

## Events to Index

### Outgoing — Basejump (Base)

**`BridgeInitiated`** — emitted when a user starts a transfer

```solidity
event BridgeInitiated(
    address indexed asset,     // source token address
    uint256 amount,            // gross amount (before fee)
    uint256 fee,               // fee deducted
    uint16 destChain,          // Wormhole destination chain ID
    bytes32 recipient,         // destination recipient
    uint64 transferSequence,   // TokenBridge slow-path sequence
    uint64 messageSequence     // Wormhole fast-path message sequence
)
```

### Relay — BasejumpProxy (Moonbeam)

**`TransferProcessed`** — emitted when a fast-path VAA is received and forwarded to landing

```solidity
event TransferProcessed(
    address indexed sourceAsset,
    uint256 amount,
    bytes32 indexed recipient
)
```

### Incoming — BasejumpLanding (Hydration)

**`TransferExecuted`** — tokens delivered to recipient instantly

```solidity
event TransferExecuted(
    address indexed sourceAsset,
    address indexed destAsset,
    bytes32 indexed recipient,
    uint256 amount
)
```

**`TransferQueued`** — insufficient liquidity, transfer queued for later

```solidity
event TransferQueued(
    uint256 indexed id,
    address indexed sourceAsset,
    address destAsset,
    bytes32 recipient,
    uint256 amount
)
```

**`PendingTransferFulfilled`** — queued transfer fulfilled after liquidity arrived

```solidity
event PendingTransferFulfilled(
    uint256 indexed id,
    address indexed sourceAsset,
    address destAsset,
    bytes32 recipient,
    uint256 amount
)
```

## Transfer Lifecycle

A single transfer produces events across chains in this order:

1. `BridgeInitiated` on the source chain — transfer started
2. `TransferProcessed` on the relay chain (Moonbeam for EVM→Hydration, or source EVM for Hydration→EVM) — fast-path VAA verified
3. `TransferExecuted` **or** `TransferQueued` on the destination — delivery outcome
4. (If queued) `PendingTransferFulfilled` — delivered after settlement replenished liquidity

## Correlation

Link events into a single transfer using:

- **`recipient`** (bytes32) — present in all events
- **`sourceAsset`** + **`amount`** — match across events (note: `BridgeInitiated.amount` is gross, delivery events use net = `amount - fee`)
- **`transferSequence`** / **`messageSequence`** from `BridgeInitiated` — can be cross-referenced with Wormhole VAA data if needed

## Transfer States

| State       | Determined by                                    |
| ----------- | ------------------------------------------------ |
| `initiated` | `BridgeInitiated` seen                           |
| `processed` | `TransferProcessed` seen                         |
| `completed` | `TransferExecuted` seen                          |
| `queued`    | `TransferQueued` seen                            |
| `fulfilled` | `PendingTransferFulfilled` seen (after `queued`) |

## Notes

- V1 supports a single token: EURC (`0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` on Base)
- `recipient` is bytes32 — on EVM it's a left-zero-padded address, on Substrate it's an AccountId32
- New source chains will be added with the same contract interfaces and event signatures
- The `Withdrawn` and `DestAssetUpdated` events on BasejumpLanding are admin-only and can be ignored for transfer indexing
