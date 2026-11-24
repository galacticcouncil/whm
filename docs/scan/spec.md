# scan — WHM chain indexer

## Abstract

`scan` (`@whm/scan`, image `galacticcouncil/scan`) indexes the chains this repo's contracts run on
and serves what it finds. One image, one entry point per container:

| Container       | Entry              | Owns                                                   | Port |
| --------------- | ------------------ | ------------------------------------------------------ | ---- |
| `ingest`        | `ingest/app.js`    | `events` + core tables, `wh_messages`, `ntt_transfers` | —    |
| `app-intents`   | `intents/app.js`   | `intent_orders`                                        | 8080 |
| `app-transfers` | `transfers/app.js` | `basejump_transfers`, `utxo_transfers`, `utxo_signs`   | 8081 |
| `app-feeds`     | `feeds/app.js`     | `oracle_updates`                                       | 8082 |
| `ui`            | `ui/app.js`        | nothing — pages, and a proxy to each app               | 8083 |

**Ingest is the only writer of the event store.** Every app reads it, owns its own tables, and serves
its own open API: reads, `/api/status`, and a live stream at `/api/events`. The UI is one site over
all of them.

Chains are indexed in parallel and at very different speeds, so events reach a reader in no
particular order. Every table is built to come out ordered anyway: state advances by rank and never
regresses, and every other column merges rather than overwrites.

## Architecture

```
               ┌──────────────────── ingest ────────────────────┐
chains ──► watchers ──► events (seq) ──► Drain ──► wh_messages, ntt_transfers
                             │  pg_notify scan_events
                             ▼
             ┌─────────────┬──────────────┬─────────────┐
             │ intents     │ transfers    │ feeds       │   each: Drain ──► own tables
             │ + 1Click    │ + 2 pollers  │ + prune     │         serve ──► /api/*
             └──────┬──────┴──────┬───────┴──────┬──────┘
                    └─────────────┼──────────────┘
                                  ▼
                        ui  /api/<section>/* proxy + pages
```

- **Watchers** ([src/chains/](../../agents/scan/src/chains/)) — one per enabled chain, in ingest. Each
  writes raw events to `events` and nudges readers over `pg_notify('scan_events', chain)`.
- **Readers** ([src/flow/drain.ts](../../agents/scan/src/flow/drain.ts)) — every container but the UI
  runs one `Drain` over its own flows. It keeps a position per chain in `readers`, takes events by
  `seq` in batches of 500, and advances that position in the **same transaction** as the rows it
  writes, so a crash re-reads rather than loses. A batch that fails is retried row by row; an event
  that still fails twice is parked in `dead_events` and stepped over, so one poison log never wedges
  the queue. The nudge is an optimisation — `DRAIN_INTERVAL_MS` is the backstop.
- **Routing** — a leg is claimed by `(chain, address, topic0)`. The role a leg names is turned into
  addresses through the watch list, so two flows can read identically named events from different
  contracts, and a flow can read the same event (the Wormhole core's publish) that another flow does.
- **Row notices** — every committed change is broadcast in-process (to SSE subscribers) and
  announced on `pg_notify('scan_rows', …)` as `{flow, kind, id, state, previousState}`. An app that
  shows a table another process owns follows it (`follow`) and relays the notice onto its own stream —
  `transfers` follows ingest's `ntt`.
- **UI** ([src/ui/app.ts](../../agents/scan/src/ui/app.ts)) — holds no state and touches no database.
  It serves `public/ui/`, `public/shared/` and `public/fonts/`, and streams `/api/<section>/<path>` to
  `<app>/api/<path>` for `transfers`, `orders` and `feeds`, event streams included, so the pages are
  one origin while the apps stay public on their own ports.

### Module layout (`agents/scan/src/`)

| Path               | Role                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| `config.ts`        | The whole env surface besides chain endpoints                            |
| `deployments.ts`   | What is deployed where, per protocol and chain — addresses only          |
| `watch.ts`         | What to index: watch entries, roles, start blocks                        |
| `chains/<kind>/`   | `consts`, `factory` (config from env), `types`, `watcher` per chain kind |
| `chains/events.ts` | The JSON events the Solana watcher decodes into                          |
| `chains/zcash/`    | Zcash tx parsing, address encoding, Blockchair inclusions                |
| `db.ts`            | Core schema; event store, cursors, readers, rewinds, rebuilds, notify    |
| `flow/`            | The reconciler: DDL generation, upsert, drain, serve, static pages       |
| `ingest/`          | The writer, the `messages` and `ntt` flows, NTT payload parsing, VAA ids |
| `apps/<domain>/`   | One per container: flows, db queries, api, pollers, entry point          |
| `ui/app.ts`        | The site and its proxy                                                   |
| `admin.ts`         | Cursors, rewinds, rebuilds                                               |

## Watch model

A **watch entry** ([src/types.ts](../../agents/scan/src/types.ts) `Watch`) is the unit of both
ingestion and backfill. It keeps its own cursor, so a new entry backfills from its own `from` while
everything already indexed stays at the tip.

| Field    | Meaning                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------ |
| `chain`  | Chain name                                                                                       |
| `role`   | What a flow addresses the contracts by — never an address                                        |
| `id`     | The cursor's name, default `role`. A second entry under one role backfills newly added contracts |
| `from`   | First block / slot                                                                               |
| `at`     | Contracts kept — addresses; NEAR accounts; Solana programs                                       |
| `via`    | NEAR / Solana: accounts whose history surfaces `at`'s events (default `at`)                      |
| `calls`  | NEAR: calls into `at` kept as events carrying their arguments                                    |
| `topics` | Positional topic filter; an array is an OR, `null` any                                           |
| `sender` | EVM: resolve the tx sender (one receipt per matched tx), for events that do not name it          |

The entries ([src/watch.ts](../../agents/scan/src/watch.ts)):

| Role                            | Chains                                         | What                                                                     |
| ------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| `wormhole-core`                 | hydration, ethereum, base, robinhood, hyperevm | Core, filtered to every NTT transceiver (+ intent emitter on Hydration)  |
| `wormhole-core`                 | near                                           | Core, read via every NTT manager account                                 |
| `wormhole-core`                 | solana                                         | Core, read via every NTT program, filtered to their emitter PDAs         |
| `ntt`                           | all of the above                               | Every token's manager + transceiver, in one entry per chain              |
| `intent-emitter`                | hydration                                      | `IntentEmitter`                                                          |
| `intent-receiver`               | ethereum                                       | `IntentReceiver`                                                         |
| `basejump-source`               | ethereum                                       | `BasejumpEmitter` (`sender: true`)                                       |
| `basejump-landing`              | hydration                                      | `BasejumpLanding`                                                        |
| `utxo-emitter`                  | hydration                                      | `ZecUtxoEmitter`                                                         |
| `utxo-withdraw`                 | near                                           | `withdraw-zec.hydration-whm.near`                                        |
| `utxo-connector`                | near                                           | `zcash-connector.bridge.near` via `ntt-zec`, keeping `verify_deposit_v2` |
| `wormhole-core` / `oracle-core` | ethereum, robinhood, hydration, solana         | Core, filtered to the oracle emitters, under its own cursor              |
| `oracle-receiver`               | hydration, robinhood                           | Every `OracleReceiver` landing on that chain                             |

Two choices worth knowing:

- **The cores are filtered to our own emitters.** Unfiltered, Ethereum's core is thousands of
  messages a day. NEAR's and Solana's cores are shared, so they are read only through our own
  accounts' histories (`via`), and Solana's is still filtered by emitter.
- **A manager and its transceiver share an entry.** A delivery emits `ReceivedMessage` on the
  transceiver and `TransferRedeemed` on the manager in one transaction, and only the first names the
  VAA. One entry is one `getLogs`, so they are stored — and drained — in log order.

Start blocks default to 2026-10-01 00:00 UTC on each chain (`OCT_1`); `SEPT_1` and the full-history
blocks are kept beside it for a larger dataset. ZEC's UTXO entries start at their own deploys.

## Chains

A chain is on when its endpoint is set; watch entries on a chain without one are skipped. NEAR and
Solana are always on — their public endpoints need no key and carry enough for NTT's volume. Chain
ids, Wormhole ids and tuning defaults live in each kind's `consts`.

| Chain     | Kind      | Wormhole id | Endpoint             | Defaults                                            |
| --------- | --------- | ----------- | -------------------- | --------------------------------------------------- |
| ethereum  | evm       | 2           | `RPC_ETHEREUM_WSS`   | 3 confirmations, 9,000-block chunks, 3 in flight    |
| base      | evm       | 30          | `RPC_BASE_WSS`       | same                                                |
| hyperevm  | evm       | 47          | `RPC_HYPEREVM_HTTP`  | 1,000-block chunks, 1 in flight                     |
| robinhood | evm       | 72          | `RPC_ROBINHOOD_HTTP` | 1,000,000-block chunks (100 ms blocks)              |
| hydration | substrate | 73          | `RPC_HYDRATION_WSS`  | EVM chain id 222222; 0 confirmations, 100 in flight |
| near      | near      | 15          | `RPC_NEAR_TX`        | FastNEAR public tx API; 10 s poll                   |
| solana    | solana    | 1           | `RPC_SOLANA_HTTP`    | public mainnet RPC; 10 s poll                       |

### EVM

`RPC_<CHAIN>_WSS` subscribes to heads and caches the tip; the sweep runs off it, so the node is never
polled for a block number. `RPC_<CHAIN>_HTTP`, for an endpoint with no websocket, asks for the head
each sweep. Each watch entry is one `getLogs` per chunk with its own topic filter, against its own
cursor, up to `head − confirmations`. Block timestamps are fetched only for blocks that produced a
log, and senders only where the entry asks.

### Hydration (substrate)

Read over substrate, never `eth_getLogs`: the Basejump landing's deliveries are XCM-driven
`pallet_evm` calls with no ethereum receipt, visible only as Frontier `EVM.Log` events.

- Finalized heads arrive by subscription. Ranges of 100 blocks are read as hashes in one
  `chain_getBlockHash` and raw `System.Events` in one `state_queryStorage` (falling back to one block
  at a time on a node that refuses it). Events are decoded only when a watched address appears in a
  block's raw bytes.
- Blocks are read whole, so one pass serves every role at that height; an entry added later with an
  older start pulls the scan back for all of them, and the duplicate inserts are ignored.
- An `EVM.Log` never names its transaction. Logs are buffered and take the hash (and sender) of the
  `Ethereum.Executed` that Frontier emits after them. XCM-driven logs have none and keep a
  `<blockHash>-<eventIndex>` identity, plus the `<block>-<index>` of the extrinsic they ran in
  (`events.extrinsic`).
- A watchdog exits the process when a drain hangs, handing recovery to the orchestrator.

### NEAR

NEAR has no log filter, and a shared contract's own history is everyone's. So it is read through
FastNEAR's transaction index: the history of the accounts we own (`via`), then those transactions
whole. Only events logged or called by a contract a watch keeps are stored.

- A NEP-297 log is stored like an EVM log: `topic0 = keccak256("<standard>:<event>")`, the data its
  JSON, one row per element of its `data` array. A call named in `calls` is stored the same way
  under the standard `call`, carrying its arguments. Log index is `receipt × 1000 + event`.
- The cursor is held just below the first transaction still running, so it is read again once whole;
  one still unfinished 600 blocks on is taken as it stands.

### Solana

Read through `getSignaturesForAddress` of the programs we own, then those transactions whole, all at
`finalized`. NTT on Solana logs nothing useful, so each transaction is decoded instruction by
instruction ([src/chains/solana/decode.ts](../../agents/scan/src/chains/solana/decode.ts)) into JSON
events stored like NEAR's ([src/chains/events.ts](../../agents/scan/src/chains/events.ts)):

| Event              | Meaning                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `wormhole:publish` | A core post in NEAR's core's shape; emitter as its second topic. Through the post-message shim it carries the shim's payload and VAA timestamp |
| `ntt:received`     | A VAA verified by a manager: its digest, VAA id and inbox item                                                                                 |
| `ntt:released`     | Released to the recipient — by digest where the tx names one, else inbox item                                                                  |
| `ntt:queued`       | Held by the inbound rate limit                                                                                                                 |

The cursor stays 300 slots (~2 min) below the head and that window is re-read every pass: the RPC is
many nodes behind one URL, and the one listing signatures can lag the one giving the head.
`RPC_SOLANA_WSS`, where set, only wakes the poll early on a `logsSubscribe` notice.

## Flow engine

A **flow** ([src/types.ts](../../agents/scan/src/types.ts) `Flow`) is a table, the legs that fill it,
and how a row advances. **Legs sharing a key are the same record.**

```ts
export const orders: Flow = {
  name: "orders",
  table: "intent_orders",
  key: { column: "transfer_sequence", type: "BIGINT" },
  states: { placed: 0, processed: 1, settled: 2, refunded: 2, failed: 2 },
  requires: { processed: "placed" },
  columns: {
    caller: "TEXT",
    amount_in: "NUMERIC",
    placed: "JSONB",
    processed: "JSONB",
  },
  legs: [
    {
      role: "intent-emitter",
      abi: OrderPlacedEvt,
      state: "placed",
      key,
      patch,
    },
  ],
};
```

- **Schema** ([flow/schema.ts](../../agents/scan/src/flow/schema.ts)) — generated and idempotent: the
  table (`key`, `state`, columns, `updated_at`), an `ADD COLUMN IF NOT EXISTS` per column so a new
  field reaches an existing table, unique indexes, `state` / `updated_at` indexes, extra `indexes`,
  and `<table>_state_rank(state)`.
- **Upsert** ([flow/upsert.ts](../../agents/scan/src/flow/upsert.ts)) — state moves only to a higher
  rank; every other column is `COALESCE`d, so a leg carrying part of the record leaves the rest alone.
  Equal ranks are alternative outcomes, not a sequence.
- **Leg** — names a `role`, optionally narrowed to `chains`; exactly one of `abi` (EVM event) or
  `near` (`{standard, event}` — NEAR's NEP-297, a kept call, or a Solana decoded event); the `state`
  it claims; `key(args, ev, db)` returning the row's key or `null` to drop it; and `patch`. `key` may
  be async and gets the drain's transaction, for events that do not name their own record.
- **`keyBy` / `unique`** — a leg may address the row by an alternate unique column. It cannot create
  the row, only update one an earlier leg bound — log order guarantees that within a transaction.
- **`requires`** — ref column → the ref column it presupposes. A row with a downstream leg and no
  origin (a delivery whose source was never indexed) is an orphan: hidden from lists and counts
  rather than shown half-built.
- **Refs** — each leg stores where it happened as JSONB `EventRef`:
  `{chain, blockNumber, blockTimestamp (unix ms), txHash, logIndex, extrinsic?}`.

Pollers that carry a row past what any chain shows (1Click, NEAR withdrawals, Zcash confirmations)
write through the same `reconcile` and broadcast the result, so they obey the same rank rules.

## Data model

### Core ([src/db.ts](../../agents/scan/src/db.ts))

| Table         | Key                           | Meaning                                                                                                                           |
| ------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `events`      | `(chain, tx_hash, log_index)` | Raw store: address, block, `block_timestamp` (ms), topics, data, `sender?`, `extrinsic?`; `seq BIGSERIAL` is what readers read by |
| `cursors`     | `(chain, role)`               | How far each watch entry has indexed (`role` holds the cursor id)                                                                 |
| `readers`     | `(name, chain)`               | Each reader's last `seq` per chain                                                                                                |
| `rewinds`     | `(chain, cursor)`             | Asked-for re-scans, applied by the chain's watcher at its next tick                                                               |
| `rebuilds`    | `reader`                      | Asked-for rebuilds, applied by the reader at its next drain                                                                       |
| `dead_events` | `(reader, chain, seq)`        | Events a reader could not process, with the error                                                                                 |

`seq` only orders rows inserted serially — true because one ingest process writes each chain in one
awaited loop. Two ingest replicas would break it. Cursors per entry mean `seq` does not follow block
order across roles; the flows tolerate that by design.

### Ingest

| Table           | Key      | States                                             |
| --------------- | -------- | -------------------------------------------------- |
| `wh_messages`   | `vaa_id` | `published`                                        |
| `ntt_transfers` | `digest` | `published 0 → received 1 → queued 2 → redeemed 3` |

`vaa_id` is `<wormholeChainId>/<emitter32>/<sequence>` — Wormhole's own form, pasteable into
wormholescan.

**`wh_messages`** — every message our emitters publish (NTT, intent instructions, oracle updates),
from EVM `LogMessagePublished` and NEAR / Solana `wormhole:publish`: emitter, sequence, nonce,
consistency (NEAR's is 0 — guardians sign NEAR only at finality), payload.

**`ntt_transfers`** — both directions, keyed on the digest NTT settles delivery on,
`keccak256(sourceChainId ++ encodedNttManagerMessage)`, derived from the published payload because
nothing on-chain publishes it beside the VAA. Whichever end is indexed first creates the row.

| Leg                                                     | Chain  | Sets                                                                                                                 |
| ------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `LogMessagePublished` / `wormhole:publish`              | any    | `published`: vaa_id, managers, `manager_sequence`, sender, amount + decimals (trimmed), token, recipient, `to_chain` |
| `ReceivedMessage` (by `vaa_id`)                         | EVM    | `received`, `vaa_hash`                                                                                               |
| `TransferRedeemed` / `InboundTransferQueued`            | EVM    | `redeemed` / `queued`, `settled`                                                                                     |
| `whm-ntt:transfer_sent` (by `vaa_id`)                   | NEAR   | `sender_account`                                                                                                     |
| `whm-ntt:transfer_received` / `transfer_queued_inbound` | NEAR   | `redeemed` / `queued`, `recipient_account` — NEAR verifies and releases in one call                                  |
| `ntt:received`                                          | Solana | `received`, binds `vaa_id` and `inbox_item`                                                                          |
| `ntt:released` / `ntt:queued`                           | Solana | `redeemed` / `queued`, by digest, else by `inbox_item`                                                               |

The terminal states are exclusive at first delivery: a rate-limited transfer is queued and credits
nothing, and `completeInboundQueuedTransfer` emits `TransferRedeemed` later — so `redeemed` outranks
`queued`. `ReceivedMessage` names only the VAA, so on a cold backfill where the destination runs
ahead of the source it finds no row; it carries only a hash and a timestamp, and live operation
publishes well before it delivers, so that is a cold-start artifact.

`manager_sequence` is what features riding the rail correlate on (none on Solana, whose transfers
are named by an outbox item, read back off the payload).

## Domains

### Intents (`app-intents`)

**`intent_orders`**, keyed by the NTT manager's `transfer_sequence` — what `IntentReceiver` itself
pairs a settlement and its instruction on. States `placed 0 → processed 1 → settled | refunded |
failed 2`; `processed` requires `placed`.

| Leg                                    | Chain     | Sets                                                                                                                             |
| -------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `OrderPlaced`                          | hydration | `placed`: caller, deposit address, asset in, amount in, ETH out, max relay fee                                                   |
| `LogMessagePublished` from the emitter | hydration | `settlement_sequence` (the emitter's own counter, intents only), `instruction_vaa` — keyed by the instruction's leading `uint64` |
| `OrderProcessed`                       | ethereum  | `processed`: forwarded amount                                                                                                    |
| `RelayFeePaid`                         | ethereum  | relay fee, relayer — same tx, same state                                                                                         |

Reads join the WETH corridor's `ntt_transfers` row (scoped to the Hydration WETH manager, since the
manager's sequence is shared with every other WETH transfer) and its `wh_messages`.

**Settlement poller** ([apps/intents/settlement.ts](../../agents/scan/src/apps/intents/settlement.ts)) —
`processed` is the end of what any chain shows; NEAR still swaps and delivers. Every
`ONECLICK_POLL_MS` (15 s), for each `placed` or `processed` order, it calls 1Click
`getExecutionStatus(depositAddress)` (5 at a time) and stores the raw `settlement_status`, the
destination address / asset / amount / tx, the quoted amount, and refund amount / reason / tx.
`SUCCESS → settled`, `REFUNDED → refunded`, `FAILED → failed`; anything else keeps the current state,
and an unchanged non-terminal status is not written. `placed` is polled too, since the quote already
names the destination. Disabled without `ONECLICK_JWT`.

**Token metadata** — Hydration asset symbols / decimals / icons (via `@galacticcouncil/sdk-next`,
an aToken drawn as its underlying) and 1Click's token list, each loaded once. The only chain this
container touches, so it needs `RPC_HYDRATION_WSS`.

### Transfers (`app-transfers`)

One list for everything Hydration moves, whichever rail carries it.

**`basejump_transfers`**, key `id`. States `initiated 0 → completed | queued 1 → fulfilled 2`;
`completed` and `queued` require `initiated`, `fulfilled` requires `queued`.

| Leg                        | Chain     | Key                                                                                         |
| -------------------------- | --------- | ------------------------------------------------------------------------------------------- |
| `BridgeInitiated`          | ethereum  | `init-<chain>-<transferSequence>`, adopting the oldest matching orphan payout               |
| `TransferExecuted`         | hydration | Oldest un-delivered source by `(source_asset, recipient, net_amount)`, else `orphan-exec-…` |
| `TransferQueued`           | hydration | Same match, else `orphan-queue-…`; sets `pending_id = <landing>:<id>`                       |
| `PendingTransferFulfilled` | hydration | By `pending_id`                                                                             |

Landing events carry no sequence, so correlation is a lookup against the drain's own transaction.
The fast path often pays out before its Ethereum source is read (instant VAA, source read behind its
head), so the payout waits as an orphan and the source renames it to its own key on arrival.
`pending_id` is namespaced by landing, so several landings never collide.

**`utxo_transfers`**, key = source transaction (`<chain>:<txHash>`, or the extrinsic for a
substrate-only call), unique `digest`. States `requested | deposited 0 → withdrawn 1 → confirmed 2`.
Routes are in [apps/transfers/utxo/routes.ts](../../agents/scan/src/apps/transfers/utxo/routes.ts)
(ZEC today).

- **Deposit** — one NEAR transaction: Omni's relayer calls `verify_deposit_v2` on the connector
  (arguments carry the raw Zcash tx, so payer, deposit address, amount, refund address and the
  Hydration recipient), the connector logs `utxo_added` (the txid) and `verify_deposit_details`
  (bridge fee, success), and the manager publishes — recognised as ours by sender
  `sha256(connector)`.
- **Withdrawal** — one Hydration transaction: `WithdrawRequested` on the emitter (amount, fee, the
  derived NEAR account, destination) and the NTT publish (recognised by sender = emitter). NEAR then
  delivers to the derived account (`ntt_transfers`), `withdraw-zec` signs (`utxo_signs`), anyone
  relays, and the coin pays out on Zcash.
- **`WithdrawPoller`** (20 s) — for withdrawals delivered and signed but not withdrawn, reads the
  derived account's history on FastNEAR for the connector's `generate_btc_pending_info`: the payout
  txid, plus fees and received amount from `withdraw_btc_detail`. Each row takes the first withdraw
  at or after its delivery — one withdraw takes the whole balance and may cover several.
- **`ConfirmPoller`** (60 s) — asks Blockchair whether each known payout has landed → `confirmed`.

**`utxo_signs`**, key `<txHash>:<logIndex>` — every `whm-utxo-withdraw:signed` delegate (action,
account, address, amount, input). Its own table because the sign is on NEAR and the withdrawal's row
on Hydration, read at different speeds. A withdrawal is matched to the last sign for its account
after its NEAR delivery and before its withdraw.

**The list** ([apps/transfers/db.ts](../../agents/scan/src/apps/transfers/db.ts)) unions three
sources into one shape — `id` (`<kind>:<key>`), kind, type, time, both chains and addresses, symbol,
decimals, amount, fee, status, stage:

| Source                                    | Types                                          | Stage                                                                                                          |
| ----------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `ntt_transfers` not claimed by a UTXO row | `transfer`, `intent` (sender = intent emitter) | `published → received → queued \| redeemed`                                                                    |
| `utxo_transfers`                          | `deposit`, `withdraw`                          | deposit: `deposited → published → redeemed`; withdraw: `requested → received → signed → withdrawn → confirmed` |
| `basejump_transfers`                      | `basejump`                                     | `initiated → completed \| queued → fulfilled`                                                                  |

Status folds each into `pending`, `held` (queued), `completed` or `failed` (a refused deposit).
Addresses are shown as their chain writes them: EVM trimmed from 32 bytes, Solana in base58, NEAR as
the account once the delivery names it. Symbols come from
[apps/transfers/tokens.ts](../../agents/scan/src/apps/transfers/tokens.ts) by source manager (NEAR's
`sha256(account)`, Solana's program key, trimmed to 20 bytes).

### Feeds (`app-feeds`)

**`oracle_updates`**, key `<source>:<assetId>:<vaaTime>`. States `published 0 → delivered 1`.

| Leg                                          | Chain                          | Sets                                                                              |
| -------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------- |
| `LogMessagePublished` from a relay's emitter | ethereum, robinhood, hydration | asset, `vaa_time` (block time), action (1 price, 2 rate), value, sequence, vaa_id |
| `wormhole:publish` from Solana's emitter     | solana                         | same, `vaa_time` from the shim's event                                            |
| `PriceReceived`                              | hydration, robinhood           | `delivered`, value, dest chain, receiver                                          |

`PriceReceived` names no VAA, only its timestamp, so updates are keyed by source, asset and that
timestamp, and either end may land first. Relays: Ethereum, Solana and Robinhood into Hydration,
Hydration into Robinhood (`ORACLE` in [deployments.ts](../../agents/scan/src/deployments.ts)); feeds
in [apps/feeds/feeds.ts](../../agents/scan/src/apps/feeds/feeds.ts) — wstETH, apyUSD, SOL, JitoSOL,
PRIME, SPY, HDX.

- A receiver refuses an update older than 300 s or out of order, so an undelivered publish is
  `pending` within that window and `expired` after it.
- A feed's value, age and chart are the oracle's own — what the receiver wrote and when.
- A feed with no delivery for a week is **dead**, but only once its destination is indexed that far
  (`receiver.indexedTo`), so a chain still backfilling does not kill every feed landing on it.
- Postgres has no TTL: the app prunes rows older than 30 days, hourly. The event store keeps them,
  so a rebuild brings them back until the next prune.

## API

Every app ([flow/serve.ts](../../agents/scan/src/flow/serve.ts)):

- `GET /api/health` → `{ ok: true }`
- `GET /api/status` → `{ name, uptime, reader: {chain: seq}, chains: {name: {rpc, kind, chainId,
wormholeId, safe, roles: {cursor: block}}}, flows: {flow: {state: count}} }` — every chain in the
  watch list; `safe` only from ingest, which has the watchers.
- `GET /api/events?flow=<a,b>` → SSE, events `created` / `updated`, data
  `{flow, kind, record, previousState}`; a followed flow's record is `{id, state}`. 15 s heartbeat.

Per app:

| App       | Endpoint                     | Notes                                                                                                                          |
| --------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| intents   | `GET /api/orders`            | `state` (comma list), `address` (caller, deposit, destination, or any tx), `limit` ≤ 1000 (100), `offset`; newest placed first |
| intents   | `GET /api/orders/:sequence`  | With rail columns: `vaa_id`, `digest`, `rail_state`, `wormhole_sequence`, …                                                    |
| intents   | `GET /api/tokens`            | `{ hydration: {assetId: meta}, dest: {1ClickAssetId: meta} }`                                                                  |
| transfers | `GET /api/transfers`         | `from`, `to`, `asset`, `type`, `status` (comma lists), `q` (address in any form, or any tx), `limit` ≤ 1000 (25), `offset`     |
| transfers | `GET /api/transfers/:id`     | `{ view, record }` — the list's view and the rail's own row                                                                    |
| transfers | `GET /api/filters`           | Chains, assets, types, statuses the list can be filtered by                                                                    |
| feeds     | `GET /api/feeds`             | Every feed: latest delivery, 24 h counts, week sparkline, receiver + `indexedTo`                                               |
| feeds     | `GET /api/feeds/:id`         | One card, plus the emitter                                                                                                     |
| feeds     | `GET /api/feeds/:id/series`  | `range` = `24h` \| `7d` \| `30d`                                                                                               |
| feeds     | `GET /api/feeds/:id/updates` | Newest first, `limit` ≤ 200 (25), `offset`                                                                                     |

The UI serves `/` (→ `/transfers`), `/transfers[/:id]`, `/orders[/:id]`, `/feeds`, `/feed/:id`, and
proxies `/api/transfers/*`, `/api/orders/*`, `/api/feeds/*` to the matching app.

## Configuration

Endpoints and secrets are env; **everything else is code** — chain ids, addresses and start blocks
live in [src/chains/](../../agents/scan/src/chains/), [deployments.ts](../../agents/scan/src/deployments.ts)
and [watch.ts](../../agents/scan/src/watch.ts), so a deployment cannot silently point at the wrong
contract.

| Variable                                                | Used by           | Default                                | Notes                                                                    |
| ------------------------------------------------------- | ----------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`                                          | all but ui        | — (required)                           | Postgres                                                                 |
| `PORT`                                                  | all               | 8080                                   |                                                                          |
| `RPC_<CHAIN>_WSS` / `RPC_<CHAIN>_HTTP`                  | ingest            | —                                      | EVM: `ETHEREUM`, `BASE`, `ROBINHOOD`, `HYPEREVM`; WSS must be `ws(s)://` |
| `CONFIRMATIONS_<CHAIN>`                                 | ingest            | 3 (EVM), 0 (Hydration)                 |                                                                          |
| `CHUNK_SIZE_<CHAIN>`                                    | ingest            | per chain, else 9,000                  | EVM                                                                      |
| `CONCURRENCY_<CHAIN>`                                   | ingest            | 3 EVM, 100 Hydration, 3 NEAR, 2 Solana |                                                                          |
| `RPC_HYDRATION_WSS`                                     | ingest, intents   | —                                      | Substrate endpoint, not the EVM one                                      |
| `CHECKPOINT_EVERY_HYDRATION`                            | ingest            | 500                                    |                                                                          |
| `RPC_NEAR_TX` / `POLL_MS_NEAR`                          | ingest, transfers | FastNEAR public / 10,000               |                                                                          |
| `RPC_SOLANA_HTTP` / `RPC_SOLANA_WSS` / `POLL_MS_SOLANA` | ingest            | public / — / 10,000                    | WSS only wakes the poll                                                  |
| `LIVE_POLL_INTERVAL_MS`                                 | ingest            | 12,000                                 | Backstop sweep; heads drive it                                           |
| `DRAIN_INTERVAL_MS`                                     | readers           | 5,000                                  | Backstop drain; ingest's nudge drives it                                 |
| `ONECLICK_JWT` / `ONECLICK_POLL_MS`                     | intents           | — / 15,000                             | No JWT, no settlement polling                                            |
| `TRANSFERS_API` / `ORDERS_API` / `FEEDS_API`            | ui                | `localhost:8081/8080/8082`             | Upstream apps                                                            |

## Operations

```sh
cd agents/scan
pnpm dev:db                 # postgres on :5432
pnpm build                  # dist/<domain>/app.js per entry
pnpm dev ingest             # or: intents, transfers, feeds, ui — one container's worth, watched
pnpm admin <command>        # bundles and runs admin.ts with .env
```

Entries are declared in [esbuild.entries.mjs](../../agents/scan/esbuild.entries.mjs) — ESM, packages
external, one bundle per container. The image copies `dist/` and `public/`; deploy with
`docker:deploy` then `docker:up` ([docker-compose.yml](../../agents/scan/docker-compose.yml): the
five services plus `postgres:16`).

**Re-indexing** — both are requests the running processes apply at their next tick; nothing stops:

```sh
node admin.js cursors [chain]                     # every cursor, and how far it has got
node admin.js rewind <chain> <block> [cursor...]  # re-scan from <block>; no cursor = all on the chain
node admin.js rebuild <reader>                    # empty a reader's tables, replay the store
```

- **Rewind** lowers cursors (never raises them). Events already stored are skipped, so overshooting
  is free; events found for the first time reach every reader as new.
- **Rebuild** (`ingest`, `intents`, `transfers`, `feeds`) truncates that reader's tables, its
  positions and its dead events in one transaction, then replays the store — for a new leg or
  changed flow logic over events already stored. Poller-written columns are re-fetched as rows come
  back.

**Adding something to index** — append a watch entry (a new role, or a second `id` under an existing
one), add its addresses to `deployments.ts`, and add the leg to a flow. A new column on an existing
flow is added at the next boot but filled only by a rebuild.
