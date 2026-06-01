# EVM Oracle Emitter

## Abstract

Hydration's on-chain oracle pipeline needs **rate** data from Ethereum-mainnet assets (wstETH, apyUSD, and any future ERC-4626 / view-readable feed that exposes an 18-decimal `uint256`). The EVM Oracle Emitter is the Ethereum-side counterpart of the Solana `message-emitter` program: it reads source contracts directly on-chain, ABI-encodes the value into the WHM oracle payload, and publishes it through Wormhole. A dedicated `MessageDispatcher` proxy on Moonbeam then routes the VAA to Hydration's oracle store via XCM.

## Overview

A single upgradeable Solidity contract on Ethereum mainnet (`OracleEmitter`) holds a registry of feeds. Each feed binds an `assetId` to an on-chain source contract and a `staticcall` calldata blob. `send(assetId)` does the `staticcall`, decodes the return as a 18-decimal `uint256`, and emits a Wormhole VAA with the same `(action, assetId, price, timestamp)` ABI encoding the Solana emitter uses. Action is hard-coded to `ACTION_RATE_UPDATE = 2` — this contract is rate-only. Off-chain broadcasters trigger sends on a schedule or when the value drifts past a threshold; relayers carry the VAA to Moonbeam.

The contract is intentionally minimal — it only knows how to call a function and read back a single 18-decimal `uint256`. Decimal normalisation, action selection, and source-specific shapes (Chainlink `latestRoundData`, Pyth `PriceFeed` struct, signed `int256`, etc.) are out of scope and would be added either via tiny adapter contracts that flatten to 18-dec rate, or via a UUPS upgrade when first needed.

## Architecture

### Ethereum — OracleEmitter (UUPS Proxy)

Reads exchange rates directly from source contracts on Ethereum mainnet and publishes them as Wormhole VAAs.

**`send(bytes32 assetId)` — payable, permissionless**

1. Looks up the `Feed` for `assetId`. Reverts if unregistered.
2. `staticcall(feed.source, feed.call)` — reads the source contract.
3. Decodes the return as `uint256` (assumed 18-decimal — see [Key design decisions](#key-design-decisions)).
4. ABI-encodes payload: `(action: uint8 = 2, assetId: bytes32, rate: uint256, timestamp: uint64)`.
5. Calls `wormhole.publishMessage{value: fee}(nonce, payload, 200)` — `consistencyLevel = 200` (Ethereum finalised).
6. Increments `nonce`. Returns the Wormhole sequence number.

**`registerFeed(assetId, source, call)` — onlyOwner**

- Creates or overwrites the binding for `assetId`.
- `call` is the full ABI-encoded calldata to `staticcall` against `source` — e.g. `abi.encodeWithSelector(IWstETH.stEthPerToken.selector)` or `abi.encodeCall(IERC4626.convertToAssets, (1e18))`.
- The owner is responsible for picking a `call` whose return value is an 18-decimal `uint256`. No normalisation; no decimals declaration.

**`removeFeed(assetId)` — onlyOwner**

- Deletes the binding.

### Moonbeam — parallel relay stack

The existing `oracle-relay` Moonbeam stack (Solana → Moonbeam → Hydration) has been renounced to a zero owner — `MessageDispatcher.setAuthorizedEmitter`, `setOracle`, UUPS upgrades, and even `XcmTransactor.setAuthorized` are all uncallable. Configuring it to accept Ethereum-sourced VAAs is therefore not possible.

Adding Ethereum as a source instead requires a **fresh parallel stack** on Moonbeam: a new `XcmTransactor` proxy + new `MessageDispatcher` proxy using the existing Solidity contracts unchanged. The contracts are not chain-coupled — only the per-deployment `authorizedEmitters`, `handlers`, and `oracles` mappings need to differ. Its decode, stale-check, 1e10 scaling, and XCM dispatch logic apply identically to the Solana side.

This is the [`oracle-relay-eth` migration](#deployment).

### Hydration — new MDA authorisation required

Each Moonbeam `XcmTransactor` proxy executes on Hydration as a distinct multilocation-derived account (MDA), and per [spec.md design decision #4](spec.md#key-design-decisions) each Hydration oracle contract whitelists a single MDA as the authorised `setPrice` caller. The new `XcmTransactor` proxy therefore has a different MDA than the existing one, so each target oracle on Hydration must additionally authorise this new MDA. This is a Hydration-parachain task, tracked as a follow-up — not in this repo.

### Off-chain — broadcaster

The existing `agents/broadcaster` service is Solana-aware today. The plan is to refactor it behind a chain-adapter interface so the same orchestration logic (`thresholds.json`, full-refresh interval, change-detection, state persistence) drives sends on both chains. See [follow-up section](#off-chain-broadcaster-follow-up).

## Initial feeds

| Asset    | source                                       | call                                 | Published value           |
| -------- | -------------------------------------------- | ------------------------------------ | ------------------------- |
| `wstETH` | `0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0` | `stEthPerToken()`                    | stETH per 1 wstETH        |
| `apyUSD` | `0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A` | `convertToAssets(uint256)` with 1e18 | apxUSD per 1 apyUSD share |

Both sources return a `uint256` at 18 decimals natively; the emitter publishes the return value verbatim.

**Units and denomination.** Published values are in the source contract's **native rate units** — not converted to USD or any external reference. Specifically:

- `wstETH` is published as **stETH per wstETH** (Lido's internal NAV — sample mainnet value `≈ 1.2355` × 10¹⁸).
- `apyUSD` is published as **apxUSD per apyUSD share** (vault's underlying is apxUSD at `0x98A8…4665`, not USD — sample mainnet value `≈ 1.3712` × 10¹⁸). USD denomination would require an additional apxUSD/USD feed layered on the consumer side.

This mirrors the Solana program, which publishes Kamino Scope and SPL Stake Pool values in their native units without conversion. All transformation is on-chain; the emitter does not depend on off-chain quote conversion.

**assetId scheme:** `keccak256(symbol)` — e.g. `keccak256("WSTETH")`, `keccak256("APYUSD")`. Deterministic, no collision risk, and human-readable in migration definitions.

## Payload encoding

Identical to the Solana emitter's `abi_encode_price_payload` ([helpers.rs](../../platforms/solana/programs/message-emitter/src/helpers.rs)):

```
bytes   0..32  : action     (uint8, left-padded — always 2 for this emitter)
bytes  32..64  : assetId    (bytes32)
bytes  64..96  : rate       (uint256, 18-dec native from source)
bytes  96..128 : timestamp  (uint64, left-padded)
```

128 bytes total, all static, decoded on Moonbeam by `abi.decode(payload, (uint8, bytes32, uint256, uint64))`.

The `timestamp` field is informational. The dispatcher's stale-check uses `vm.timestamp` (VAA observation time), not the payload timestamp.

## Key design decisions

1. **Direct on-chain reads.** Both wstETH and apyUSD expose their rate as a pure view function on the token contract itself. The emitter reads in the same transaction it publishes, so the VAA carries the freshest possible value with no off-chain feeder dependency. This is a strictly stronger property than the Solana side, where Kamino Scope's value is maintained by an off-chain crank.
2. **Rate-only, 18-decimal native.** Action is hard-coded to `ACTION_RATE_UPDATE = 2`. Decimal normalisation is not implemented — sources are expected to return an 18-dec `uint256`. The two initial feeds (wstETH, apyUSD) satisfy this natively; non-conforming future sources would either be wrapped in a tiny adapter contract that flattens to 18-dec, or added via a UUPS upgrade that reintroduces a per-feed scaling factor.
3. **Generic single-uint256 decoder.** The contract only knows how to call a function and read back a `uint256`. Source-specific shapes (Chainlink tuples, Pyth struct, signed `int256`) are deliberately out of scope. They become tiny adapter contracts when first needed, leaving the emitter trivially auditable.
4. **Permissionless `send`.** Anyone can trigger a publish; they pay the Wormhole fee. No keeper allowlist. Matches the existing `MessageEmitter.sendMessage` pattern.
5. **Owner-gated registry.** Feed registration is the only privileged action. The owner is the deployer (transferable via `setOwner`).
6. **UUPS upgradeable.** Same proxy pattern as the rest of the Moonbeam stack. The day a new source kind is needed (price feeds, decimal scaling, struct decoders), the emitter is upgraded in place without re-wiring authorisations.
7. **`consistencyLevel = 200` (finalised) on Ethereum.** Oracle data must reflect finalised state. Mirrors the Solana side's `Finality::Finalized`.
8. **Single global nonce.** Matches `MessageEmitter.sol`. Per-feed nonces would add storage cost without value — Wormhole sequence numbers are emitter-scoped already.

## How it maps to existing contracts

| Contract | Role |
| --- | --- |
| `OracleEmitter` (Ethereum) | Feed registry, direct on-chain reads, ABI-encode payload, publish Wormhole VAA |
| `MessageReceiver` / `MessageDispatcher` (Moonbeam, **new proxy**) | VAA verification, replay protection, authorised-emitter whitelist, action routing — same Solidity as `oracle-relay`, fresh proxy instance scoped to the Ethereum source |
| `XcmTransactor` (Moonbeam, **new proxy**) | SCALE-encode `evm.call`, send via XCM precompile to Hydration — fresh proxy → distinct MDA on Hydration |
| Hydration oracle contracts | Must additionally whitelist the new MDA as authorised `setPrice` caller (follow-up; out of this repo) |

## Deployment

Mainnet only. Sepolia is not in scope for this iteration; testing happens against a forked mainnet via `anvil --fork-url`.

**Wormhole core bridge (Ethereum mainnet):** `0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B`

**Wormhole chain id (Ethereum):** `2`

Rollout is split across two migrations — the Ethereum-side deploy + feed registration, and the Moonbeam-side authorisation + per-asset oracle targets. They run independently against different chains/keys and reference each other via the runner's `ctx.ref(...)` cross-migration state lookup.

**1. `oracle-emitter` (Ethereum)** — `platforms/evm/migrations/definitions/oracle-emitter/`

1. `001-deploy` — deploy `OracleEmitter` impl + `ERC1967Proxy(impl, initialize(wormholeCore))` in one step
2. `002-register-wsteth` — `registerFeed(keccak256("WSTETH"), wstETH, abi.encodeCall(stEthPerToken))`
3. `003-register-apyusd` — `registerFeed(keccak256("APYUSD"), apyUSDVault, abi.encodeCall(convertToAssets, 1e18))`

**2. `oracle-relay-eth` (Moonbeam)** — `platforms/evm/migrations/definitions/oracle-relay-eth/`

Runs after `oracle-emitter` above. Reads the Ethereum emitter proxy from the `oracle-emitter` deployment state via `ctx.ref` — cross-env override with `EMITTER_ENV` (e.g. `EMITTER_ENV=eth` when running against the moon env).

1. `001-deploy-transactor` — deploy fresh `XcmTransactor` impl + proxy
2. `002-deploy-dispatcher` — deploy fresh `MessageDispatcher` impl + proxy
3. `003-authorize-dispatcher` — `setAuthorized(newDispatcher, true)` on the new transactor
4. `004-register-emitter` — `setAuthorizedEmitter(2, ethEmitterProxy)` — Wormhole chainId 2 = Ethereum mainnet
5. `005-set-handler-rate` — `setHandler(ACTION_RATE_UPDATE, newTransactor)` on the new dispatcher
6. `006-set-oracle-wsteth` — `setOracle(keccak256("WSTETH"), wstethOracleAddress)`
7. `007-set-oracle-apyusd` — `setOracle(keccak256("APYUSD"), apyusdOracleAddress)`

Ownership is intentionally **retained** on the new stack — mirror `oracle-relay`'s `010-revoke-transactor-owner` / `011-revoke-dispatcher-owner` steps once Hydration-side MDA authorisation is wired and end-to-end is verified.

**Env files** (one per chain/env): `migrations/envs/{env}/oracle-emitter.env` and `migrations/envs/{env}/oracle-relay-eth.env` — e.g. `envs/eth/oracle-emitter.env`, `envs/fork/oracle-emitter.env`, `envs/moon/oracle-relay-eth.env`, `envs/fork/oracle-relay-eth.env`.

**Running the migrations:** both run through the shared runner via `pnpm run migration:run` — e.g. `pnpm run migration:run --migration oracle-emitter --env fork --pk 0x…`, then `pnpm run migration:run --migration oracle-relay-eth --env fork --pk 0x…`. For a forked Ethereum mainnet, start the fork first with `pnpm run fork:eth` (anvil on `:8550`).

## Flow

See [evm-emitter-schema.md](evm-emitter-schema.md) for full architecture diagrams.

## Off-chain broadcaster (follow-up)

The `agents/broadcaster` package today is Solana-only. To support the EVM emitter without duplicating orchestration:

1. Extract a `ChainAdapter` interface: `{ loadFeeds(); read(feed); send(feed); }`.
2. Move the current Anchor-based logic into `solana-adapter.ts`.
3. Add `ethereum-adapter.ts` using viem — `loadFeeds()` reads the on-chain registry, `read()` mirrors the contract's `staticcall`, `send()` signs and submits `OracleEmitter.send(assetId)`.
4. `index.ts` stays unchanged — same `thresholds.json`, same full-refresh + change-detect loop, but iterating over feeds from both adapters.

This is a separate PR from the contract work.

## What is intentionally NOT in this scope

- **Price feeds (`action = 1`) on Ethereum.** Action is hard-coded to rate-update in the contract. Hydration already derives spot prices internally from Omnipool/Stableswap activity via [pallet-ema-oracle](../../../garden/src/site/notes/wiki/pallet-ema-oracle.md). If an external Ethereum price feed becomes a real requirement, add it via UUPS upgrade.
- **Decimal normalisation.** No `sourceDecimals` field, no scale-up / scale-down logic, no truncation guards. Sources must return 18-decimal `uint256` natively; non-conforming sources need an adapter contract or a UUPS upgrade. Both initial feeds satisfy this.
- **Adapter contracts for Chainlink / Pyth.** Trivial to add later; design leaves the door open. Not built today.
- **Sepolia deployment + agent.** Not requested.
- **Permission-gated `send` / keeper allowlist.** Not requested; the existing emitter pattern is permissionless.
- **Per-feed nonces.** No use case; Wormhole sequence numbers are emitter-scoped.
