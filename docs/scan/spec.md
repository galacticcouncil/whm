# scan — WHM multi-feature event indexer

> Status (2026-06-22): **built, typechecks, bundles — not yet fork-verified.** `agents/scan/` is an
> untracked working-tree dir, uncommitted. It is the generalized successor to `agents/bjscan` and is
> intended to retire it once parity is confirmed. See "Status & remaining work" at the bottom.

## Abstract

`scan` (`@whm/scan`, Docker image `galacticcouncil/whmscan`) is a single long-running TypeScript
service that indexes on-chain events across EVM chains (viem) and Hydration (polkadot-api), correlates
them into per-feature lifecycle records, and exposes a read API + live SSE stream + a per-feature
browser UI. It generalizes `bjscan` (which was Basejump-only) into a **generic ingestion harness +
pluggable feature modules**. Today it ships two features: **basejump** and **intents (WTT)**.

## Architecture

Two layers: a generic harness that knows nothing feature-specific, and feature modules that own all
domain logic.

```
chains registry ─→ one watcher per chain ─→ raw `events` table ─→ single Processor ─→ feature handler
   (config)         evm: viem getLogs        (+ `cursors`)         decode by topic0      (decode→correlate→store→broadcast)
                    substrate: papi blocks                         route by (chain,address,topic0)
```

- **One watcher per chain.** Each watcher ingests *all* watched contracts on its chain into the shared
  `events` table. Overlapping chains (e.g. both features watch Ethereum/Hydration) are subscribed once.
- **Routing by `(chain, address, topic0)`.** The processor decodes each event against the handler
  registered for its emitting address + signature ([processor.ts](../../agents/scan/src/processor.ts) `routeKey`).
  Keying on address (not event name) lets two features emit identically-named events (both basejump and
  intents emit `BridgeInitiated`) and lets two contracts at different addresses route independently —
  this is what makes multi-landing / multi-instance work.
- **Feature manifest.** Each feature exports `{ name, contracts: [{chain, address, topics?, events}], initSchema(), routes(app), counts() }`
  ([types.ts](../../agents/scan/src/types.ts) `Feature`). `index.ts` aggregates manifests → derives the
  per-chain watched-contract set + the handler registry → starts watchers + processor → mounts routes.
  Add a feature = drop a `features/<name>/` folder and register it in [features/index.ts](../../agents/scan/src/features/index.ts).

### Module layout (`agents/scan/src/`)

| Path | Role |
| --- | --- |
| `config.ts` | env → enabled chains (evm/substrate) + per-feature contract config |
| `clients.ts` | viem `PublicClient` per evm chain; papi `PolkadotClient` per substrate chain |
| `db.ts` | core schema (`events`, `cursors`) + raw-event insert/cursor ops |
| `watchers/evm.ts`, `watchers/substrate.ts` | generic, **multi-contract** watchers (block subscribe → getLogs / EVM.Log → insert) |
| `processor.ts` | poll `events`, decode by topic0, route to handler, mark processed |
| `enrich.ts` | shared per-chain block-time + tx-sender enrichment (LRU) |
| `subscribers.ts` | feature-tagged pub-sub (`{feature, kind, record, previousState}`) for SSE + logs |
| `api/server.ts` | Fastify: `/api/health`, `/api/status`, `/api/events` (SSE) |
| `api/ui.ts` | serves `/`, `/logo.png`, `/<feature>/:id` from `public/` |
| `features/<f>/{abi,handlers,db,api,index}.ts` | one feature's events, decode/correlate, table, routes, manifest |
| `index.ts` | bootstrap |

## Data model

**Core** ([db.ts](../../agents/scan/src/db.ts)):
- `events (chain, tx_hash, log_index, address, block_number, topics[], data, ingested_at, processed_at)` — PK `(chain, tx_hash, log_index)`. Raw log firehose; single `processed_at` (one processor decodes each event once).
- `cursors (chain, block_number)` — per-chain ingestion watermark.

**Features own their tables** (created in their `initSchema()`), keyed by a correlation id, advancing monotonically through states:
- basejump → `transfers` (PK `id`), states `initiated → queued/completed → fulfilled`.
- intents → `intents` (PK `intent_id`), states `emitted → published → forwarded`.

## Chains

A chain is **enabled iff its RPC env var is set** ([config.ts](../../agents/scan/src/config.ts)). EVM chains
are added with one `evmChain(...)` line + `<PREFIX>_RPC_URL` / `<PREFIX>_START_BLOCK` — so a new L2 is
~one line. Currently wired: `base`, `ethereum`, `moonbeam` (evm), `hydration` (substrate).

## Features

### basejump

Source `BridgeInitiated` on EVM chains → landing `TransferExecuted` / `TransferQueued` /
`PendingTransferFulfilled`. Correlation: deliveries match the oldest un-delivered source by
`(source_asset, recipient, net_amount)`; queued→fulfilled match by `pending_id`. Orphan deliveries
(no source yet) get an `orphan-…` id. **Moonbeam hop is intentionally not indexed** — `BridgeInitiated`
is emitted in the same tx as the Wormhole `LogMessagePublished`, and the source already records
`message_sequence`, so the proxy leg adds nothing (VAA has instant finality).

**Multiple landings / multiple Basejump instances** (e.g. `ethereum→moonbeam→hydration` and
`base→moonbeam→hydration` deployed as independent harnesses, each with its own Moonbeam proxy +
Hydration landing): supported, and presented as **one unified transfers view — there is no
user-facing "instance" concept**. Internally:
- `BASEJUMP_LANDING_HYDRATION` is a comma-separated address list — one entry per landing. Distinct
  landing addresses route independently via `(chain,address,topic0)`.
- Correlation is by `(source_asset, recipient, net_amount)`. Distinct deployments never bridge the
  same asset, so corridors stay cleanly separated with no extra scoping needed.
- `pending_id` is namespaced by landing address, so two landings' independent id counters don't collide.

Reuse mode (one shared landing for both corridors) is the same — just one address in the list.

### intents (WTT)

The **deployed** intents path is **WTT** (Wormhole TokenBridge payload-3), NOT the Basejump BJP variant —
see [../intents/spec.md](../intents/spec.md). Three legs correlated by `intentId`:
- **emitted** — Hydration `IntentEmitterWtt.BridgeInitiated` (substrate watcher).
- **published** — Moonbeam Wormhole-core `LogMessagePublished`, narrowed by an indexed-`sender` topic to
  the TokenBridge, then the payload-3 body is parsed ([features/intents/payload.ts](../../agents/scan/src/features/intents/payload.ts))
  and kept only if addressed to the receiver; recovers `intentId` + `maxRelayFee` + Wormhole `sequence`.
- **forwarded** — Ethereum `IntentReceiver.IntentForwarded` (+ `RelayFeePaid`).
- **settled** (off-chain) — on-chain delivery isn't the end. A poller ([features/intents/settlement.ts](../../agents/scan/src/features/intents/settlement.ts))
  calls 1Click `getExecutionStatus(depositAddress)` every `INTENTS_SETTLEMENT_POLL_MS` (default 15s) for each
  `forwarded` intent, stores the raw status in `settlement_status`, and advances to a terminal state once 1Click
  reports it: `SUCCESS → succeeded`, `REFUNDED → refunded`, `FAILED → failed`. Terminal intents leave the
  `forwarded` work set, so polling stops for them. Needs `ONECLICK_JWT`.

Requires at least one Ethereum receiver (`INTENT_RECEIVER_ETHEREUM`); the published leg additionally
requires the Moonbeam chain enabled (the Wormhole core + token bridge are hardcoded). Emitter and receiver
are comma-separated lists, so multiple deployments fold into one unified view. The settlement poller runs via
the feature manifest's optional `start()` hook (kicked off after watchers).

## API

Core ([api/server.ts](../../agents/scan/src/api/server.ts)):
- `GET /api/health` → `{ ok: true }`
- `GET /api/status` → uptime, per-chain `{kind, chainId, cursor, safe}`, per-feature state counts
- `GET /api/events?feature=<name>` → SSE; events `created` / `updated`, data `{feature, kind, record, previousState}`

Per feature:
- basejump: `GET /api/basejump/transfers?state=&address=&asset=&limit=&offset=`, `GET /api/basejump/transfers/:id`
- intents: `GET /api/intents?state=&address=&limit=&offset=`, `GET /api/intents/:id`

## UI

Per-feature browser pages mirroring bjscan's detail view, served from `public/` ([api/ui.ts](../../agents/scan/src/api/ui.ts)):
- `/` — landing index: feature cards with live counts (from `/api/status`), an "open by id" box, recent records per feature.
- `/basejump/:id` — transfer detail (ported from bjscan; legs initiated→queued/completed→fulfilled + Wormhole card).
- `/intents/:id` — intent detail (emitted→published→forwarded→succeeded/refunded/failed, with the raw 1Click `settlement_status`; Hydration/Moonbeam/Ethereum + wormholescan links).
- `/logo.png` — shared.

All pages live-update via the feature-filtered SSE stream (match on `record.id` / `record.intent_id`). Assets
are copied into the image (`COPY public ./public`) and read at startup.

## Configuration (env)

| Var | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | — (required) | Postgres |
| `PORT` | 8080 | |
| `POLL_INTERVAL_MS` / `LIVE_POLL_INTERVAL_MS` | 5000 / 12000 | processor drain / live tail cadence |
| `<CHAIN>_RPC_URL` | — | enables the chain (ws/wss). Prefixes: `BASE`, `ETHEREUM`, `MOONBEAM` |
| `<CHAIN>_START_BLOCK` | — (required if enabled) | backfill start |
| `<CHAIN>_CONFIRMATIONS` / `_CHUNK_SIZE` / `_CONCURRENCY` | 3 / 9000 / 3 | evm tuning |
| `HYDRATION_WSS_URL` | — | enables Hydration |
| `HYDRATION_CHAIN_ID` / `_START_BLOCK` / `_CONFIRMATIONS` / `_CONCURRENCY` / `_CHECKPOINT_EVERY` | 222222 / — / 0 / 100 / 500 | |
| `BASEJUMP_BASE` | — | Base source bridge(s); comma-separated list (prod `0xf5b9…529b`) |
| `BASEJUMP_ETHEREUM` | — | optional Ethereum source bridge(s) |
| `BASEJUMP_LANDING_HYDRATION` | — | Hydration landing(s); comma-separated list (prod `0x70e9…f976`) |
| `INTENT_EMITTER_HYDRATION` | — | IntentEmitterWtt(s); comma-separated list (prod `0x059e…3dd0`) |
| `INTENT_RECEIVER_ETHEREUM` | — | IntentReceiver(s), required for intents; comma-separated (prod `0xf1a5…d188`) |
| `ONECLICK_JWT` | — | 1Click API JWT for the intents settlement poller (required when intents is enabled) |
| `INTENTS_SETTLEMENT_POLL_MS` | 15000 | settlement poll cadence |

Every contract-address role is a **comma-separated list** (multiple deployments → one unified view) with
**no code defaults** — set them in `.env` / docker-compose. The Moonbeam **Wormhole core** (`0xc8e2…29f3`)
and **token bridge** (`0xb173…7d92`) are fixed infra, **hardcoded** in [config.ts](../../agents/scan/src/config.ts).

## Build & run

```sh
cd agents/scan
pnpm dev:db        # local Postgres (docker-compose.dev.yml)
pnpm dev           # esbuild watch → dist/index.js
pnpm build         # bundle (CJS, node) → dist/index.js
pnpm start         # node dist/index.js
```

Bundles to a single `dist/index.js` via the shared [esbuild.config.mjs](../../esbuild.config.mjs) (runtime
deps only in the package; toolchain in root — same convention as other agents). Docker copies `dist/` +
`public/`; deploy via `docker:deploy` / `docker:up`.

## Relation to bjscan

Same job, generalized. Three changes vs bjscan: (1) route by **topic0** not event name (both features emit
`BridgeInitiated`); (2) **multiple contracts per chain** (bjscan pinned one); (3) **feature-scoped** tables +
`/api/<feature>/*` + `public/<feature>.html`. The basejump feature is a behavior-port of bjscan; intents is new.

## Status & remaining work

- ✅ Workspace member, `tsc --noEmit` clean, esbuild bundles, per-feature UI, multi-landing basejump.
- ⏳ **Never run against a fork/live** — no functional validation (schema executes, ingestion, `/api/*`,
  UI render, end-to-end correlation). Next: `pnpm dev:db` + fork/live RPCs.
- ⏳ **basejump parity** vs old bjscan not diffed.
- ⏳ **bjscan not retired** — both present; scan is uncommitted.
