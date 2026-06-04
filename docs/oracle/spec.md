# Oracle Relay

## Abstract

Hydration's on-chain oracles need external price + rate feeds with no native cross-chain access. Oracle Relay bridges Solana (Kamino Scope prices, SPL Stake Pool rates) and Ethereum (view-readable rates from token/vault contracts) to Hydration's on-chain oracle store via Wormhole + Moonbeam XCM.

## Overview

A source-chain emitter reads oracle data, ABI-encodes it, and publishes through Wormhole as a VAA. On Moonbeam, a dispatcher proxy validates the VAA, routes by action type, scales the value, and forwards to Hydration's oracle contract via XCM. Off-chain agents (broadcaster + relayer) drive the pipeline.

Two source chains are supported in V1:

| Source   | Emitter                            | Data                                                  | Action(s)                                            |
| -------- | ---------------------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| Solana   | `oracle-emitter` Anchor program    | Kamino Scope prices + SPL Stake Pool rates            | `ACTION_ORACLE_PRICE` (1), `ACTION_STAKE_RATE` (2)   |
| Ethereum | `OracleEmitter` Solidity (UUPS)    | View-readable 18-dec rates (wstETH, apyUSD, …)        | `ACTION_RATE_UPDATE` (2) — rate-only                 |

The Moonbeam dispatcher stack is per-source — each source chain gets its own deployed `OracleDispatcher` + `XcmTransactor` proxy pair. The contracts themselves are shared Solidity sources; only the per-deployment mappings (authorized emitters, handlers, oracles) differ. Renounced ownership means adding a new source requires a fresh parallel stack rather than reconfiguring an existing one.

## Architecture

### Solana source — `oracle-emitter` (Anchor)

Reads on-chain prices and exchange rates and publishes them as Wormhole VAAs.

**`send_price(asset_id)` — action 1**

1. Reads `DatedPrice` from Kamino Scope oracle at the registered `price_index`
2. Normalizes price to 18 decimals
3. ABI-encodes payload: `(action=1, assetId, price, timestamp)`
4. Calls `wormhole.post_message()` — published as a signed VAA

**`send_rate(asset_id)` — action 2**

1. Reads `total_lamports` and `pool_token_supply` from a registered SPL Stake Pool
2. Computes `total_lamports / pool_token_supply` normalized to 18 decimals
3. ABI-encodes payload: `(action=2, assetId, rate, timestamp)`
4. Calls `wormhole.post_message()` — published as a signed VAA

**`register_price_feed(asset_id, oracle_index)`** — owner-only; PDA `[price_feed, asset_id]` mapping asset → Scope oracle index.

**`register_pool_feed(asset_id, stake_pool)`** — owner-only; PDA `[stake_pool_feed, asset_id]` mapping asset → SPL Stake Pool. Stake pool is validated on `send_rate`.

### Ethereum source — `OracleEmitter` (Solidity UUPS)

Upgradeable Solidity contract on Ethereum mainnet. Reads exchange rates directly from source contracts via `staticcall`, ABI-encodes, and publishes through Wormhole.

**`send(bytes32 assetId)` — payable, permissionless**

1. Looks up the `Feed` for `assetId`. Reverts if unregistered.
2. `staticcall(feed.source, feed.call)` — reads the source contract.
3. Decodes the return as `uint256` (assumed 18-decimal).
4. ABI-encodes payload: `(action=2, assetId, rate, timestamp)` — same shape as Solana.
5. Calls `wormhole.publishMessage{value: fee}(nonce, payload, 200)` — `consistencyLevel = 200` (Ethereum finalised).

**`registerFeed(assetId, source, call)` — onlyOwner**

- Binds `assetId` to an on-chain source contract and a `staticcall` calldata blob (e.g. `abi.encodeCall(IWstETH.stEthPerToken, ())`).
- Owner is responsible for picking a `call` whose return is an 18-dec `uint256`. No normalization built into the emitter.

**`removeFeed(assetId)` — onlyOwner** — deletes a binding.

Action is hard-coded to `ACTION_RATE_UPDATE = 2`. Price feeds (action 1) on Ethereum are out of scope today — added via UUPS upgrade if needed.

#### Initial Ethereum feeds

| Asset    | source                                       | call                                | Published value           |
| -------- | -------------------------------------------- | ----------------------------------- | ------------------------- |
| `wstETH` | `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0` | `stEthPerToken()`                   | stETH per 1 wstETH        |
| `apyUSD` | `0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A` | `convertToAssets(uint256)` w/ 1e18  | apxUSD per 1 apyUSD share |

Both sources return 18-decimal `uint256` natively. Values are published in the source's **native rate units** — not converted to USD. USD denomination is a consumer-side concern.

**assetId scheme:** `keccak256(symbol)` — e.g. `keccak256("WSTETH")`, `keccak256("APYUSD")`.

### Moonbeam relay stack (per source)

Each source chain has its own deployed instance of three contracts. Sources are isolated by design — renounced ownership on one source's stack does not affect another.

#### `MessageReceiver` (base)

- Parses and verifies VAA via Wormhole core contract
- Authorized-emitter check against the per-source whitelist
- Replay protection via VAA hash tracking
- Passes validated payload to subclass

#### `OracleDispatcher` (extends MessageReceiver)

Action-routed forwarding to Hydration.

| Action                | ID  | Handler       |
| --------------------- | --- | ------------- |
| `ACTION_ORACLE_PRICE` | 1   | XcmTransactor |
| `ACTION_STAKE_RATE`   | 2   | XcmTransactor |

**Per-update flow:**

1. Decode `(action, assetId, value, timestamp)` from VAA payload
2. Reject stale updates (incoming timestamp ≤ latest stored)
3. Store in `latestPrices[assetId]`
4. Look up handler for action + oracle address for assetId
5. Scale value (divide by 1e10 → 8 decimals) and encode `setPrice(int256)` calldata
6. Call `XcmTransactor.transact(oracle, calldata)`

**Admin:** `setHandler(action, address)`, `setOracle(assetId, address)`, `setAuthorizedEmitter(sourceChain, address)`.

#### `XcmTransactor`

Dispatches EVM calls to Hydration's parachain via Moonbeam's XCM precompile (`0x0817`).

1. SCALE-encodes an `evm.call` extrinsic targeting the oracle contract on Hydration
2. Builds XCM multilocation for destination parachain
3. Calls `XcmTransactorV3.transactThroughSigned()` — executes on Hydration as the multilocation-derived account (MDA) of the calling Moonbeam contract

Config: `DESTINATION_PARA_ID` (Hydration = 2034), `SOURCE_PARA_ID` (Moonbeam = 2004), `FEE_LOCATION_ADDRESS` (HDX), EVM pallet/call indices.

### Hydration — MDA authorization

Each Moonbeam `XcmTransactor` proxy executes on Hydration as a distinct MDA derived from its proxy address. Each Hydration oracle contract whitelists a single MDA as the authorized `setPrice` caller.

Consequence: each source's transactor has a different MDA, so each target oracle must additionally authorize the MDA of every active source. This is a Hydration parachain governance / runtime task — not in this repo.

### Off-chain agents

**Broadcaster** (`agents/broadcaster`) — Periodically triggers source-side publish:

- Solana: calls `send_price()` and `send_rate()` on the `oracle-emitter` program
- Ethereum: calls `send(assetId)` on `OracleEmitter` (planned — current agent is Solana-aware only; chain-adapter refactor pending)

Drives a `thresholds.json`-based change-detect loop with full-refresh interval.

**Relayer** (`agents/mrelayer`) — Polls Wormhole for signed VAAs from authorized emitters and submits them to `OracleDispatcher.receiveMessage()` on Moonbeam.

## Payload encoding

128 bytes, all static, identical from both source chains:

```
bytes   0..32  : action     (uint8 left-padded — 1 for price, 2 for rate)
bytes  32..64  : assetId    (bytes32)
bytes  64..96  : value      (uint256, 18-decimal native)
bytes  96..128 : timestamp  (uint64 left-padded)
```

Decoded on Moonbeam by `abi.decode(payload, (uint8, bytes32, uint256, uint64))`. The `timestamp` field is informational — the dispatcher's stale-check uses `vm.timestamp` (VAA observation time).

## Key design decisions

1. **Action-based routing.** `OracleDispatcher` routes by action ID. New message types (governance, alerts, etc.) plug in by registering a new handler without changing the core pipeline.
2. **Stale-update rejection.** Updates with timestamp ≤ latest stored are rejected on-chain, preventing out-of-order delivery from corrupting oracle state.
3. **Price scaling.** Sources publish at 18 decimals; Hydration oracles expect 8 decimals. Dispatcher divides by 1e10 before forwarding.
4. **MDA-scoped authorization.** XcmTransactor executes on Hydration as an MDA derived from its Moonbeam proxy address. Hydration oracles whitelist this MDA. Each source's transactor has a distinct MDA.
5. **Per-source isolation.** Each source chain has its own renounceable dispatcher+transactor pair on Moonbeam. Adding Ethereum after the Solana stack was renounced required a parallel deployment, not a reconfiguration.
6. **UUPS proxies.** All Moonbeam contracts are upgradeable. Implementation can be swapped without changing proxy addresses (until ownership is renounced).
7. **Native rate units on Ethereum.** `wstETH` publishes stETH-per-wstETH, `apyUSD` publishes apxUSD-per-apyUSD — not USD-denominated. Conversion is a consumer concern. Mirrors the Solana side which publishes Scope / Stake Pool values without conversion.
8. **Direct on-chain reads (Ethereum side).** `OracleEmitter` `staticcall`s the source in the same tx as the VAA publish — the VAA carries the freshest possible value with no off-chain feeder dependency.
9. **Rate-only on Ethereum.** Action is hard-coded to `ACTION_RATE_UPDATE = 2`. Price feeds (action 1) on Ethereum would arrive via a UUPS upgrade if needed; Hydration already derives spot prices internally from Omnipool/Stableswap activity.
10. **Generic single-uint256 decoder (Ethereum side).** The Ethereum emitter only knows how to call a function and read back a `uint256`. Source-specific shapes (Chainlink tuples, Pyth struct, signed `int256`) are out of scope — they become tiny adapter contracts when first needed.
11. **Permissionless `send`.** Anyone can trigger a publish on either source emitter; they pay the Wormhole fee. No keeper allowlist.

## Deployment

Two merged migrations cover the two sources. Each is fully self-contained — deploys source emitter + Moonbeam dispatcher + transactor + wiring + ownership renunciation in one ordered run. State files live at `deployments/<context>/<migration>.json`.

| Migration                  | Steps | Source emitter                      | Moonbeam stack                      |
| -------------------------- | ----- | ----------------------------------- | ----------------------------------- |
| `oracle-relay-solana`      | 15    | `oracle-emitter` (Anchor) on Solana | Fresh dispatcher + transactor pair  |
| `oracle-relay-ethereum`    | 12    | `OracleEmitter` (UUPS) on Ethereum  | Fresh dispatcher + transactor pair  |

**Required PK env vars:**

- `PK_EMITTER` — source chain deployer (BS58 keypair for Solana; `0x…` hex for Ethereum)
- `PK_RELAY` — Moonbeam deployer (`0x…` hex)

**Env files:** `migrations/envs/prod/<migration>.env` and `migrations/envs/fork/<migration>.env`. Each holds RPC URLs, chain IDs, Wormhole core addresses for source + Moonbeam, XcmTransactor params, per-asset Hydration oracle addresses.

**Running:**

```sh
# fork
pnpm fork:moonbeam
pnpm fork:ethereum                            # only for oracle-relay-ethereum
pnpm migrate:oracle-relay-solana:fork
pnpm migrate:oracle-relay-ethereum:fork

# prod
pnpm migrate:oracle-relay-solana
pnpm migrate:oracle-relay-ethereum
```

See [migrations/README.md](../../migrations/README.md) for the migration model.

**Hydration MDA whitelisting** must be wired (Hydration parachain governance) before the renunciation phase of each migration runs. Until then, use `--pause-at` to stop before `014-renounce@transactor` (Solana migration) or `011-renounce@transactor` (Ethereum migration).

## Contract reference

| Contract              | Role                                                                   | Location                                                                |
| --------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `MessageReceiver`     | VAA verification, replay protection, authorized emitter check          | `contracts/src/MessageReceiver.sol`                                     |
| `OracleDispatcher`    | Extends receiver — action routing, stale-check, 1e10 scaling, dispatch | `contracts/src/oracles/OracleDispatcher.sol`                            |
| `XcmTransactor`       | Moonbeam → Hydration EVM call dispatcher                               | `contracts/src/XcmTransactor.sol`                                       |
| `OracleEmitter`       | Ethereum-side emitter (UUPS) — staticcall + Wormhole publish           | `contracts/src/oracles/OracleEmitter.sol`                               |
| `oracle-emitter`      | Solana-side emitter (Anchor) — Scope + Stake Pool + Wormhole           | `crates/solana/programs/oracle-emitter/`                                |

Schema diagrams: [schema.md](schema.md).
