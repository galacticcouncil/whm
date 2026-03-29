# Oracle Relay

## Abstract

On-chain oracles on Hydration need external price feeds but have no direct access to Solana price sources. Oracle Relay bridges Kamino Scope prices from Solana to Hydration's on-chain oracle via Wormhole and Moonbeam XCM.

## Overview

A Solana program reads oracle prices, ABI-encodes them, and publishes through Wormhole as VAAs. On Moonbeam, a dispatcher contract validates the VAA, routes by action type, and forwards the price to Hydration's oracle contract via XCM. Off-chain agents (broadcaster + relayer) drive the pipeline.

## Architecture

Three layers — Solana emitter, Moonbeam dispatcher stack, and off-chain agents.

### Solana — Message Emitter (Anchor Program)

Reads prices from Kamino Scope and publishes them as Wormhole VAAs.

**`send_price(asset_id)`**

1. Reads `DatedPrice` from Kamino Scope oracle for the registered price feed
2. Normalizes price to 18 decimals
3. ABI-encodes payload: `(action: u8, assetId: bytes32, price: u256, timestamp: u64)`
4. Calls `wormhole.post_message()` — published as a signed VAA

**`register_price_feed(asset_id, oracle_index)`**

- Creates a PDA `[price_feed, asset_id]` mapping an asset to its Kamino Scope oracle index
- Owner-only

### Moonbeam — MessageReceiver (base)

Receives and validates VAAs submitted by the relayer.

- Parses and verifies VAA signature via Wormhole core contract
- Checks emitter chain + address against authorized emitters whitelist
- Prevents replay via VAA hash tracking
- Passes validated payload to subclass

### Moonbeam — MessageDispatcher (extends MessageReceiver)

Routes validated messages by action type to registered handlers.

**Action routing:**

| Action                | ID  | Handler       |
| --------------------- | --- | ------------- |
| `ACTION_PRICE_UPDATE` | 1   | XcmTransactor |

**Price update flow:**

1. Decodes `(action, assetId, price, timestamp)` from payload
2. Rejects stale updates (timestamp < latest stored timestamp)
3. Stores price in `latestPrices[assetId]`
4. Looks up handler for action and oracle address for assetId
5. Scales price (divides by 1e10) and encodes `setPrice(int256)` calldata
6. Calls `XcmTransactor.transact(oracle, calldata)`

**Admin:**

- `setHandler(action, address)` — map action ID to handler contract
- `setOracle(assetId, address)` — map asset to oracle contract on Hydration

### Moonbeam — XcmTransactor

Dispatches EVM calls to Hydration parachain via Moonbeam's XCM precompile (0x0817).

**`transact(target, input)`**

1. SCALE-encodes an `evm.call` extrinsic targeting the oracle contract on Hydration
2. Builds XCM multilocation for destination parachain
3. Calls `XcmTransactorV3.transactThroughSigned()` — executes as the contract's multilocation-derived account (MDA) on Hydration

**Key config:**

| Parameter              | Description                                                          |
| ---------------------- | -------------------------------------------------------------------- |
| `DESTINATION_PARA_ID`  | Hydration parachain (2034)                                           |
| `SOURCE_PARA_ID`       | Moonbeam parachain (2004)                                            |
| `FEE_LOCATION_ADDRESS` | XCM fee asset (HDX)                                                  |
| `xcmSource`            | Derived H160 address on Hydration (auto-computed from proxy address) |

### Off-chain Agents

**Broadcaster** — Periodically calls `send_price()` on the Solana emitter program, triggering a new price VAA.

**Relayer** — Polls Wormhole for signed VAAs from the emitter, then submits them to `MessageDispatcher.receiveMessage()` on Moonbeam.

## Flow

See [schema.md](schema.md) for full architecture diagrams and encoding pipeline.

## Key Design Decisions

1. **Action-based routing** — MessageDispatcher routes by action ID. New message types (governance, alerts, etc.) plug in by registering a new handler without changing the core pipeline.
2. **Stale price rejection** — prices with timestamps older than the latest stored update are rejected on-chain, preventing out-of-order delivery from corrupting oracle state.
3. **Price scaling** — Solana prices are 18 decimals. Hydration oracles expect 8 decimals. The dispatcher divides by 1e10 before forwarding.
4. **Multilocation-derived account** — XcmTransactor executes on Hydration as an MDA derived from its Moonbeam proxy address. The oracle contract on Hydration must whitelist this MDA as an authorized price setter.
5. **UUPS proxies** — all Moonbeam contracts are upgradeable. Implementation can be swapped without changing proxy addresses or re-wiring authorizations.

## How Existing Contracts Map

| Contract            | Role                                                               |
| ------------------- | ------------------------------------------------------------------ |
| `MessageReceiver`   | Base — VAA verification, replay protection, emitter authorization  |
| `MessageDispatcher` | Extends receiver — action routing, price storage, handler dispatch |
| `XcmTransactor`     | SCALE-encodes evm.call and dispatches via XCM to Hydration         |
