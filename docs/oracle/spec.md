# Oracle Relay

## Abstract

Hydration's on-chain oracles need external price and rate feeds, and Hydration has no native
cross-chain access. Oracle Relay bridges Solana (Kamino Scope prices, SPL Stake Pool rates) and
Ethereum (view-readable rates from token/vault contracts) into Hydration's oracle store over
Wormhole — source emitter to Hydration receiver, no intermediate hop.

## Overview

A source-chain emitter reads oracle data, ABI-encodes it, and publishes it through Wormhole as a
VAA. An `OracleReceiver` on Hydration's EVM verifies the VAA, rejects stale updates, scales the
value, and calls `setPrice` on the target oracle contract directly.

Two source chains:

| Source   | Emitter                         | Data                                           | Action(s)                                          |
| -------- | ------------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| Solana   | `oracle-emitter` Anchor program | Kamino Scope prices + SPL Stake Pool rates     | `ACTION_ORACLE_PRICE` (1), `ACTION_STAKE_RATE` (2) |
| Ethereum | `OracleEmitter` Solidity (UUPS) | View-readable 18-dec rates (wstETH, apyUSD, …) | `ACTION_RATE_UPDATE` (2) — rate-only               |

Each source gets its own `OracleReceiver` deployment on Hydration. The Solidity is shared; only the
per-deployment mappings (authorized emitter, oracles) differ. Ownership is renounced at the end of
each migration, so adding a source means a fresh parallel deployment rather than reconfiguring an
existing one.

## Data flow

```
  Source (Solana or Ethereum)                      Hydration EVM

  ┌──────────────────┐                        ┌──────────────────────┐
  │ read feed        │      Wormhole VAA      │ OracleReceiver       │
  │ ABI encode:      │ ─────────────────────► │  verify VAA + emitter│
  │   action     u8  │                        │  reject replay       │
  │   assetId    b32 │                        │  reject stale        │
  │   value      u256│                        │  value ÷ 1e10 → 8dec │
  │     18-dec       │                        │         │            │
  │   timestamp  u64 │                        │         ▼            │
  └──────────────────┘                        │  oracle.setPrice()   │
                                              └──────────────────────┘
```

The relay leg — submitting the signed VAA to `OracleReceiver.receiveMessage()` — is permissionless.
See [Off-chain agents](#off-chain-agents) for what does and does not exist today.

## Architecture

### Solana source — `oracle-emitter` (Anchor)

Reads on-chain prices and exchange rates and publishes them as Wormhole VAAs.

**`send_price(asset_id)` — action 1**

1. Reads `DatedPrice` from the Kamino Scope oracle at the registered `price_index`
2. Normalizes the price to 18 decimals
3. ABI-encodes `(action=1, assetId, price, timestamp)`
4. Calls `wormhole.post_message()` — published as a signed VAA

**`send_rate(asset_id)` — action 2**

1. Reads `total_lamports` and `pool_token_supply` from a registered SPL Stake Pool
2. Computes `total_lamports / pool_token_supply`, normalized to 18 decimals
3. ABI-encodes `(action=2, assetId, rate, timestamp)`
4. Calls `wormhole.post_message()`

Feed registration, owner-only, both PDA-backed:

```
register_price_feed(asset_id, oracle_index)
    assetId      = bytes32 (canonical mint pubkey)
    oracle_index = u16     (Kamino Scope oracle index)
    → PDA [price_feed, asset_id]

register_pool_feed(asset_id, stake_pool)
    assetId    = bytes32
    stake_pool = Pubkey  (SPL Stake Pool address, validated on send_rate)
    → PDA [stake_pool_feed, asset_id]
```

### Ethereum source — `OracleEmitter` (Solidity UUPS)

Reads exchange rates directly from source contracts via `staticcall`, ABI-encodes, and publishes
through Wormhole.

**`send(bytes32 assetId)` — payable, permissionless**

1. Looks up the `Feed` for `assetId`. Reverts if unregistered.
2. `staticcall(feed.source, feed.call)` — reads the source contract.
3. Decodes the return as `uint256` (assumed 18-decimal).
4. ABI-encodes `(action=2, assetId, rate, timestamp)` — same shape as Solana.
5. `wormhole.publishMessage{value: fee}(nonce, payload, 200)`.

**`registerFeed(assetId, source, call)` — onlyOwner** binds `assetId` to a source contract and a
`staticcall` calldata blob. The owner is responsible for picking a `call` whose return is an 18-dec
`uint256`; the emitter does no normalization.

**`removeFeed(assetId)` — onlyOwner.**

Action is hard-coded to `ACTION_RATE_UPDATE = 2`. Price feeds (action 1) from Ethereum are out of
scope today — they would arrive via a UUPS upgrade.

#### Initial Ethereum feeds

| Asset    | source                                       | call                               | Published value           |
| -------- | -------------------------------------------- | ---------------------------------- | ------------------------- |
| `wstETH` | `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0` | `stEthPerToken()`                  | stETH per 1 wstETH        |
| `apyUSD` | `0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A` | `convertToAssets(uint256)` w/ 1e18 | apxUSD per 1 apyUSD share |

Both return 18-decimal `uint256` natively. Values are published in the source's **native rate
units**, not converted to USD — denomination is a consumer-side concern.

**assetId scheme:** `keccak256(symbol)` — e.g. `keccak256("WSTETH")`, `keccak256("APYUSD")`.

### Hydration — `OracleReceiver`

Extends `MessageReceiver`, which supplies VAA parsing and verification against the Wormhole core
contract, the authorized-emitter check, and replay protection by VAA hash.

Per update, `_handleOracleUpdate`:

1. Decodes `(action, assetId, value, timestamp)` from the payload.
2. Rejects when the VAA's own timestamp is at or below the last stored one — `StalePriceUpdate`.
3. Rejects when the VAA is older than `maxPriceAge` (default 300s), so a long-delayed relay cannot
   write a stale price.
4. Looks up the oracle for `assetId` — `OracleNotSet` if unregistered.
5. Stores `PriceData { price, timestamp, receivedAt }` and emits `PriceReceived`.
6. Scales by `PRICE_SCALE_DIVISOR = 1e10` (18 dec → 8 dec) and calls `oracle.setPrice(int256)`.

Note the stale check uses `vm.timestamp`, the VAA's observation time — the payload's own `timestamp`
field is informational only.

**Admin:** `setOracle(assetId, oracle)`, `setMaxPriceAge(seconds)`, `setAuthorizedEmitter(chain, addr)`.

### Hydration — oracle authorization

Each target oracle must accept `setPrice` from its `OracleReceiver`. The receiver calls the oracle
as an ordinary EVM contract on the same chain, so the oracle simply authorizes the receiver's
address.

Because each source has its own receiver deployment, an oracle serving two sources must authorize
both. That authorization lives on the Hydration side, not in this repo, and must be in place before
the migration's `renounce@receiver` step runs — use `--pause-at` to stop before it otherwise.

## Payload encoding

128 bytes, all static, identical from both sources:

```
bytes   0..32  : action     (uint8 left-padded — 1 for price, 2 for rate)
bytes  32..64  : assetId    (bytes32)
bytes  64..96  : value      (uint256, 18-decimal native)
bytes  96..128 : timestamp  (uint64 left-padded)
```

Decoded by `abi.decode(payload, (uint8, bytes32, uint256, uint64))`. The receiver reads `action`
straight out of `payload[31]` to route before decoding.

## Off-chain agents

**Broadcaster** (`agents/broadcaster`) — periodically triggers the source-side publish:

- Solana: calls `send_price()` / `send_rate()` on the `oracle-emitter` program
- Ethereum: calls `send(assetId)` on `OracleEmitter` (planned — the agent is Solana-aware only; the
  chain-adapter refactor is pending)

Driven by a `thresholds.json` change-detect loop with a full-refresh interval.

**Relay leg — not implemented.** Submitting the signed VAA to
`OracleReceiver.receiveMessage()` is permissionless. Needs an `oracle` feature in
[`agents/relayer`](../../agents/relayer/): subscribe to the source emitters, submit to the
corresponding Hydration receiver.

## Key design decisions

1. **Direct delivery.** The receiver runs on Hydration's EVM and calls the oracle in the same
   transaction that verifies the VAA — so a failed write reverts the whole call and leaves the VAA
   unconsumed and retryable.
2. **Action-based routing.** `OracleReceiver._processMessage` routes on the action byte, so new
   message types plug in without touching the oracle path.
3. **Stale-update rejection, twice.** Monotonic per asset (`vaaTimestamp > latest`) plus an absolute
   freshness bound (`maxPriceAge`). The first stops out-of-order delivery corrupting state; the
   second stops a resurrected old VAA writing a stale price.
4. **Price scaling.** Sources publish 18 decimals, Hydration oracles expect 8; the receiver divides
   by 1e10 and rejects anything that scales to zero.
5. **Per-source isolation.** Each source has its own receiver, renounced independently. Adding a
   source is a parallel deployment, never a reconfiguration.
6. **Native rate units.** `wstETH` publishes stETH-per-wstETH, `apyUSD` publishes
   apxUSD-per-apyUSD. Conversion is a consumer concern, matching the Solana side.
7. **Direct on-chain reads (Ethereum).** `OracleEmitter` `staticcall`s the source in the same
   transaction as the publish, so the VAA carries the freshest possible value with no off-chain
   feeder in the trust path.
8. **Generic single-`uint256` decoder (Ethereum).** The emitter only knows how to call a function
   and read back a `uint256`. Source-specific shapes (Chainlink tuples, Pyth structs, signed
   `int256`) become small adapter contracts when first needed.
9. **Permissionless `send`.** Anyone can trigger a publish on either emitter and pays the Wormhole
   fee. No keeper allowlist.

## Deployment

Two merged migrations, one per source. Each deploys the source emitter, the Hydration receiver, the
wiring, and the ownership renunciation in one ordered run. State files live at
`deployments/<context>/<migration>.json`.

| Migration               | Steps | Source emitter                      | Destination                    |
| ----------------------- | ----- | ----------------------------------- | ------------------------------ |
| `oracle-relay-solana`   | 10    | `oracle-emitter` (Anchor) on Solana | `OracleReceiver` on Hydration  |
| `oracle-relay-ethereum` | 8     | `OracleEmitter` (UUPS) on Ethereum  | `OracleReceiver` on Hydration  |

**Required PK env vars:**

- `PK_EMITTER` — source chain deployer (BS58 keypair for Solana; `0x…` hex for Ethereum)
- `PK_RECEIVER` — Hydration deployer

**Env files:** `migrations/envs/<context>/<migration>.env` — RPC URLs, chain ids, Wormhole core
addresses for source and Hydration, and per-asset oracle addresses.

```sh
# fork
pnpm fork:hydration
pnpm fork:ethereum                            # oracle-relay-ethereum only
pnpm migrate:oracle-relay-solana fork
pnpm migrate:oracle-relay-ethereum fork

# prod
pnpm migrate:oracle-relay-solana prod
pnpm migrate:oracle-relay-ethereum prod
```

See [migrations/README.md](../../migrations/README.md) for the migration model.

## Contract reference

| Contract          | Role                                                                | Location                                  |
| ----------------- | ------------------------------------------------------------------- | ----------------------------------------- |
| `MessageReceiver` | VAA verification, replay protection, authorized-emitter check       | `contracts/src/MessageReceiver.sol`       |
| `OracleReceiver`  | Extends receiver — action routing, stale checks, scaling, `setPrice` | `contracts/src/oracles/OracleReceiver.sol` |
| `OracleEmitter`   | Ethereum emitter (UUPS) — `staticcall` + Wormhole publish            | `contracts/src/oracles/OracleEmitter.sol` |
| `oracle-emitter`  | Solana emitter (Anchor) — Scope + Stake Pool + Wormhole              | `crates/solana/programs/oracle-emitter/`  |
