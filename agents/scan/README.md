# @whm/scan

Indexes the chains this repo's contracts run on, and serves what it finds.

One image, several entry points. **Ingest** is the only writer: it reads every watched contract into
a shared event store, then folds that store into the two tables no feature owns — the Wormhole
messages our emitters publish, and the NTT transfers riding them. Every app reads what ingest
wrote, owns its own tables, and serves its own open API — reads, and a live stream at `/api/events`
anyone may subscribe to. The **UI** is one site over all of them.

```
ingest           chains → events → wh_messages + ntt_transfers      (no UI)
app-intents      intent_orders + 1Click                             :8080
app-transfers    every transfer: NTT, UTXO coins via Omni, Basejump :8081
app-feeds        oracle relay updates, each feed's value over time  :8082
ui               Hydration scan: Transfers · Orders · Feeds         :8083
```

The UI holds no state and touches no database. It serves every page, and passes `/api/<section>/…`
through to that section's app — `transfers`, `orders`, `feeds` — live streams included, so the pages
are one origin while the apps stay public on their own ports. `TRANSFERS_API`, `ORDERS_API` and
`FEEDS_API` name the apps; they default to the ports above on this host.

Chains are indexed **in parallel and at wildly different speeds**, so events arrive in no
particular order. Every flow is built to come out ordered anyway: state advances by rank and never
regresses, and every other column merges rather than overwrites.

## Layout

```
src/
  chains/          one folder per chain kind — everything chain-specific is in it
    index.ts         the registry (CHAINS), and the watcher for a chain by its kind
    evm/             consts, factory (config from env), types, watcher (getLogs)
    substrate/       same, for Hydration — EVM.Log out of System.Events
    near/            same, plus fastnear.ts — account histories and whole transactions
    solana/          same, plus rpc.ts and decode.ts — program signatures, instructions decoded
    events.ts        the JSON events the Solana watcher decodes into
  watch.ts         WHAT to index: contracts, roles, start blocks
  db.ts            the shared event store
  admin.ts         rewind a chain, rebuild a reader
  flow/            the reconciler: types, DDL generation, upsert, drain, serve
  ingest/          the writer, plus the wh_messages and ntt_transfers flows
  apps/<domain>/   one per container: flows, api, workers, entry point
  ui/              the site: every page, and a proxy to each section's app
public/
  shared/          styling and helpers every page uses
  ui/              the pages — transfers, orders, feeds, and a detail page for each
```

## Configuration

Endpoints and secrets are env. **Everything else is code** — chain ids, contract addresses and
start blocks live in [src/chains/](src/chains/) and [src/watch.ts](src/watch.ts), so a
deployment cannot silently point at the wrong contract.

| Variable             | Meaning                                                               |
| -------------------- | --------------------------------------------------------------------- |
| `RPC_ETHEREUM_WSS`   | Websocket. Heads arrive over `eth_subscribe`, never by polling.       |
| `RPC_BASE_WSS`       | Same, for Base.                                                       |
| `RPC_ROBINHOOD_HTTP` | Robinhood's public RPC has no websocket: `_HTTP` polls heads.         |
| `RPC_HYPEREVM_HTTP`  | Same; its public RPC caps getLogs at 1,000 blocks — the default here. |
| `RPC_HYDRATION_WSS`  | Must be the substrate path, not the EVM one — see below.              |
| `RPC_NEAR_TX`        | Optional. FastNEAR's transaction API; defaults to the public one.     |
| `RPC_SOLANA_HTTP`    | Optional. Solana JSON-RPC; defaults to the public one.                |
| `RPC_SOLANA_WSS`     | Optional. Its `logsSubscribe` wakes the watcher before the poll.      |
| `DATABASE_URL`       | Postgres.                                                             |
| `ONECLICK_JWT`       | The intents domain's off-chain leg.                                   |
| `PORT`               | Defaults to 8080.                                                     |

Every EVM chain takes `RPC_<CHAIN>_WSS` or, where its endpoint has no websocket, `RPC_<CHAIN>_HTTP`.
A chain is enabled by the presence of its RPC and disabled by its absence; watch entries on a chain
with no endpoint are skipped. NEAR and Solana are the exception: their public endpoints need no key,
and NTT puts little enough through them that those are enough, so they are always on.

NTT on Solana logs nothing of its own. Its watcher reads the transactions that touch our managers
and decodes them instruction by instruction into JSON events stored like NEAR's ([src/chains/events.ts](src/chains/events.ts)): Wormhole publishes in NEAR's core's
shape, and deliveries by the digest their VAA derives. A Solana release names no VAA, only the
inbox item that digest derives, so that is what it is matched by.

Hydration must be read over substrate: the Basejump landing's deliveries are XCM-driven
`pallet_evm` calls with no ethereum receipt, so `eth_getLogs` cannot see them at all. Only Frontier
`EVM.Log` events expose them.

That has a consequence worth knowing. An `EVM.Log` never names its own transaction, so the hash
comes from the `Ethereum.Executed` that Frontier emits _after_ the logs of each ethereum call — the
watcher buffers logs and assigns the hash when it arrives. The XCM-driven deliveries have no such
event, and keep a `blockHash-eventIndex` identity instead, which is the only name they have. The UI
links the first kind to `/extrinsic/<hash>` and the second to `/event/<block>-<index>`.

NEAR has no log filter, so it is read through FastNEAR's transaction index: the history of the
accounts we own, then those transactions whole. A shared contract — the Wormhole core, Omni's
connector — is read through the accounts of ours that call it (`via`), never through its own
history. A NEP-297 log is stored like an EVM log, `topic0 = keccak256("<standard>:<event>")` and the
event's JSON as data; a call named in `calls` is stored the same way under the standard `call`,
carrying its arguments. A leg names `near: { standard, event }` instead of `abi`.

## Adding something to index

Append a watch entry:

```ts
{ chain: "ethereum", role: "basejump-source", from: 25_828_484n, at: [ADDRESS] }
```

A watch entry is the unit of both ingestion and backfill — it keeps its own cursor, so a new entry
backfills from its own `from` while everything already indexed stays at the tip. A flow then names
the `role`, never an address, which is what lets a redeployment or a second deployment of the same
role be a one-line change.

A role that gains contracts later gets a second entry with its own `id` — the cursor's name — so
the new contracts backfill from their own `from` while the first entry stays at the tip.

## Re-indexing

Two kinds, both filed as requests that the running processes apply at their next tick — nothing is
stopped, and nothing races a watcher's or a reader's own writes:

```sh
node admin.js cursors [chain]                     # how far every cursor has got
node admin.js rewind <chain> <block> [cursor...]  # re-scan from <block>; no cursor = all on the chain
node admin.js rebuild <reader>                    # empty a reader's tables, replay the store
```

- **Rewind** re-reads a chain. Events already stored are skipped, so it is free to overshoot; events
  found for the first time reach every reader as new.
- **Rebuild** re-applies the store to one reader (`ingest`, `intents`, `transfers`, `feeds`) — for a new leg
  or changed flow logic over events already stored. Its tables are emptied and refilled; anything a
  poller wrote is re-fetched as the rows come back.

## Storage

Small. Measured on 2026-10-18 over 18 days of every watched chain, from 2026-10-01:

| What                     | Rows  | Size      |
| ------------------------ | ----- | --------- |
| `events` — the raw store | 7,394 | 6.8 MB    |
| `wh_messages`            | 2,305 | 2.7 MB    |
| `oracle_updates`         | 1,721 | 2.6 MB    |
| `ntt_transfers`          | 551   | 1.2 MB    |
| everything else          | < 100 | < 1 MB    |
| **database**             |       | **22 MB** |

About 1.2 MB a day — some 35 MB a month, 450 MB a year at that rate. The volume on disk reads more
(81 MB) because Postgres's own catalogs and WAL come first. By chain, the store holds Hydration's
4,011 events, Solana's 1,634, Robinhood's 528, Ethereum's 518, HyperEVM's 362, Base's 234 and
NEAR's 107.

Only `oracle_updates` grows fast enough to want one, and the feeds app
prunes it to 30 days itself; everything else is kept, so any reader can be rebuilt from the store.

## Adding a flow

A flow is a table, the events that fill it, and how a row advances:

```ts
export const orders: Flow = {
  name: "orders",
  table: "intent_orders",
  key: { column: "transfer_sequence", type: "BIGINT" },
  states: { placed: 0, processed: 1, settled: 2, refunded: 2, failed: 2 },
  requires: { processed: "placed" },
  columns: { caller: "TEXT", amount_in: "NUMERIC", placed: "JSONB", processed: "JSONB" },
  legs: [{ role: "intent-emitter", abi: OrderPlacedEvt, state: "placed", key, patch }],
};
```

**Legs sharing a key are the same record.** That is the whole of what "belongs together" means
here. The table, its indexes and its state-rank function are generated from the definition.

- `states` maps a state to its rank. Equal ranks are alternatives rather than a sequence — Basejump
  either clears the landing pool or waits on a shortfall, so `completed` and `queued` share a rank.
- `requires` maps a leg to the leg it presupposes. A row carrying a delivery whose origin was never
  indexed is an orphan and is hidden rather than shown half-built.
- `key` may be async and is handed the drain's transaction, for the events that do not name their
  own record. Basejump's landing events carry no sequence, so they are matched against what is
  already stored.
- `keyBy` lets a leg address the row through a unique column instead of the primary key.

## Running it

```sh
pnpm dev:db                 # postgres on :5432
pnpm build
pnpm dev ingest             # or: intents, transfers, feeds, ui
```

`pnpm dev <domain>` rebuilds and runs one container's worth — they are separate processes, so run
ingest alongside whichever domain you are working on, and `ui` to see its pages. Locally the apps
run on ports of your choosing, so point the UI at them with `TRANSFERS_API`, `ORDERS_API` and
`FEEDS_API` in `.env`.

## Notes on the NTT rail

`ntt_transfers` is keyed on the digest NTT settles delivery on, because it is the one name every
delivery event carries. Nothing on-chain publishes that digest beside its VAA — the transceiver's
`ReceivedMessage` carries the VAA _hash_, which is a different value — so it is derived from the
published payload exactly as NTT computes it,
`keccak256(sourceChainId ++ encodedNttManagerMessage)`.

The two terminal states are exclusive at first delivery. A rate-limited transfer emits
`InboundTransferQueued` and returns before anything is credited, so `TransferRedeemed` is the
release and nothing else is; `completeInboundQueuedTransfer` emits it later, which is why
`redeemed` outranks `queued`.

One consequence worth knowing: `ReceivedMessage` addresses its row by VAA id, so on a cold backfill
where a destination chain runs ahead of its source it can find nothing to update. It carries only a
hash and a timestamp, and live operation publishes ~15 minutes before it delivers, so this is a
cold-start artifact rather than a running concern.

## Transfers (the transfers app)

One list for everything Hydration moves, whichever rail carries it, and one detail page per
transfer. `/api/transfers` unions three sources into one shape — time, type, both ends, amount, fee,
status — and `/api/transfers/:id` returns that view beside the rail's own row.

- **NTT** — `ntt_transfers`, read as ingest wrote it: WETH (Ethereum), NEAR and ZEC (the NEAR hub).
  A transfer another rail claims is listed under that rail instead.
- **UTXO coins** — `utxo_transfers`, keyed by the source transaction; each coin is a route in
  `apps/transfers/utxo/routes.ts`.
  - A **deposit** is one NEAR transaction: Omni's relayer proves the coin's payment
    (`verify_deposit_v2`, whose arguments carry the raw transaction — so who paid, and to which
    deposit address), the connector mints into the coin's NTT manager, and the manager publishes.
    Its NTT transfer is recognised by its sender, `sha256(connector)`.
  - A **withdrawal** starts as one Hydration transaction — the emitter's `WithdrawRequested` and the
    NTT publish, recognised by its sender, the emitter. NEAR delivers to the account its destination
    derives (`ntt_transfers`), `withdraw-zec` signs (`utxo_signs`), anyone relays, and the coin pays
    out on its own chain. The last two are on no watched account, so two pollers carry them: the
    derived account's history for the connector's `generate_btc_pending_info` (the payout txid), and
    Blockchair for the payout's block, once a minute.
- **Basejump** — `basejump_transfers`, the fast path out of the landing pool.

Stages: NTT `published → received → redeemed | queued`; a deposit `deposited → published →
redeemed`; a withdrawal `requested → received → signed → withdrawn → confirmed`.

## Oracles (the feeds app)

Every update the oracle relays carry, and each feed's value over time. A relay is a source-chain
emitter publishing `(action, assetId, value, timestamp)` through Wormhole, and an `OracleReceiver`
on the destination writing it into the oracle there — Ethereum, Solana and Robinhood into
Hydration, Hydration into Robinhood (`ORACLE` in `deployments.ts`; feeds in
`apps/feeds/feeds.ts`).

- The emitters are read off their chain's Wormhole core under a cursor of their own,
  `oracle-core`, so they backfill without moving the core's NTT cursor. Solana's emitter posts
  through Wormhole's post-message shim, whose instruction carries the payload and whose event the
  VAA's timestamp.
- `PriceReceived` names no VAA, only its timestamp — the publishing block's, or the shim's — so
  `oracle_updates` is keyed by source, asset and that timestamp, and either end may land first.
- A receiver refuses an update older than five minutes or out of order, so a publish that never
  delivers is shown **expired** once it is past that window.
- A feed's value, its age and its charts are the oracle's own: what the receiver wrote, and when. A
  feed nothing has been delivered to for a week is **dead** — once its destination is indexed that
  far, so a chain still backfilling does not kill every feed landing on it.
- Postgres has no TTL, so the app prunes `oracle_updates` to the last 30 days, hourly.

In the UI, `/feeds` is a card per feed — latest value, a week's sparkline — and `/feed/:id` its
chart (24H, 7D, 30D) above every update published, delivered or not.
