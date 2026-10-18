import pg from "pg";

import log from "./logger";
import { databaseUrl } from "./config";

export const pool = new pg.Pool({ connectionString: databaseUrl });

/**
 * Core schema, owned by ingest and read by every flow.
 *
 * `events.seq` is the watermark a flow reads by. It is assigned at insert, so it only orders rows
 * that were inserted serially — which holds because one process ingests a chain and writes its logs
 * in a single awaited loop. Two ingest replicas on one chain would break it. Cursors are per
 * (chain, role) so a backfilling role can trail the tip without dragging the others back; the price
 * is that `seq` then stops matching block order, which the flows tolerate by design.
 */
const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq             BIGSERIAL,
  chain           TEXT NOT NULL,
  tx_hash         TEXT NOT NULL,
  log_index       INTEGER NOT NULL,
  address         TEXT NOT NULL,
  block_number    BIGINT NOT NULL,
  block_timestamp BIGINT NOT NULL,
  topics          TEXT[] NOT NULL,
  data            TEXT NOT NULL,
  -- Only where a watch entry asks for it; most events name whoever matters themselves.
  sender          TEXT,
  PRIMARY KEY (chain, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_events_seq ON events (chain, seq);

CREATE TABLE IF NOT EXISTS cursors (
  chain        TEXT NOT NULL,
  role         TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  PRIMARY KEY (chain, role)
);

CREATE TABLE IF NOT EXISTS readers (
  name  TEXT NOT NULL,
  chain TEXT NOT NULL,
  seq   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (name, chain)
);

-- Asked-for re-scans: the watcher owning the chain lowers the named cursors ('*' for all of them)
-- to just before block_number at its next tick, then clears the row.
CREATE TABLE IF NOT EXISTS rewinds (
  chain        TEXT NOT NULL,
  cursor       TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain, cursor)
);

-- Asked-for rebuilds: the named reader empties its tables and replays the store from the start.
CREATE TABLE IF NOT EXISTS rebuilds (
  reader       TEXT PRIMARY KEY,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dead_events (
  reader    TEXT NOT NULL,
  chain     TEXT NOT NULL,
  seq       BIGINT NOT NULL,
  tx_hash   TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  error     TEXT NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (reader, chain, seq)
);
`;

/** Channel ingest nudges readers over, so a drain never waits out its backstop interval. */
export const EVENTS_CHANNEL = "scan_events";

export async function initCore(): Promise<void> {
  await pool.query(CORE_SCHEMA);
  log.info("db core ready");
}

export interface EventRow {
  seq: string;
  chain: string;
  tx_hash: string;
  log_index: number;
  address: string;
  block_number: string;
  block_timestamp: string;
  topics: string[];
  data: string;
  sender: string | null;
}

/** One raw log, as ingest writes it. */
export interface RawEvent {
  txHash: string;
  logIndex: number;
  address: string;
  blockNumber: bigint;
  blockTimestamp: number;
  topics: readonly string[];
  data: string;
  sender?: string;
}

/**
 * Write a batch of logs. Duplicates are ignored, so a re-scan of the same range is free.
 *
 * @param chain Chain name.
 * @param events The logs, in block then log-index order.
 * @returns How many were new.
 */
export async function insertEvents(chain: string, events: RawEvent[]): Promise<number> {
  let inserted = 0;
  for (const e of events) {
    const r = await pool.query(
      `INSERT INTO events (chain, tx_hash, log_index, address, block_number, block_timestamp, topics, data, sender)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
      [
        chain,
        e.txHash,
        e.logIndex,
        e.address.toLowerCase(),
        e.blockNumber.toString(),
        e.blockTimestamp,
        e.topics,
        e.data,
        e.sender?.toLowerCase() ?? null,
      ],
    );
    inserted += r.rowCount ?? 0;
  }
  return inserted;
}

export async function loadCursor(chain: string, role: string): Promise<bigint | null> {
  const r = await pool.query(`SELECT block_number FROM cursors WHERE chain = $1 AND role = $2`, [
    chain,
    role,
  ]);
  return r.rows[0] ? BigInt(r.rows[0].block_number) : null;
}

export async function saveCursor(chain: string, role: string, block: bigint): Promise<void> {
  await pool.query(
    `INSERT INTO cursors (chain, role, block_number) VALUES ($1, $2, $3)
     ON CONFLICT (chain, role) DO UPDATE SET block_number = EXCLUDED.block_number`,
    [chain, role, block.toString()],
  );
}

/** How far each role on a chain has indexed — the lowest is what the chain has truly covered. */
export async function chainCursors(chain: string): Promise<Record<string, string>> {
  const r = await pool.query(`SELECT role, block_number FROM cursors WHERE chain = $1`, [chain]);
  return Object.fromEntries(r.rows.map((x) => [x.role, x.block_number]));
}

/**
 * Apply and clear the rewinds asked for on a chain. A cursor only ever moves back here, never
 * forward, and one with no row yet starts from its watch entry's `from` anyway.
 *
 * Run by the watcher at the start of its tick, so it never races the watcher's own cursor writes.
 *
 * @param chain Chain name.
 * @param ids Every cursor the watcher keeps on it — what `*` expands to.
 */
export async function applyRewinds(chain: string, ids: string[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `DELETE FROM rewinds WHERE chain = $1 RETURNING cursor, block_number`,
      [chain],
    );
    for (const { cursor, block_number } of r.rows) {
      const targets = cursor === "*" ? ids : [cursor];
      await client.query(
        `UPDATE cursors SET block_number = LEAST(block_number, $3::bigint - 1)
          WHERE chain = $1 AND role = ANY($2)`,
        [chain, targets, block_number],
      );
      log.info(`[${chain}] rewind ${cursor} to ${block_number}`);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ─── Reader side ─────────────────────────────────────────────────

/** Tell readers a chain has new events. Best-effort: the backstop interval covers a missed nudge. */
export async function notifyEvents(chain: string): Promise<void> {
  try {
    await pool.query(`SELECT pg_notify($1, $2)`, [EVENTS_CHANNEL, chain]);
  } catch {
    // a nudge is an optimisation, never a correctness requirement
  }
}

/**
 * Subscribe to ingest's nudges on a dedicated connection — LISTEN holds its session, so it cannot
 * share the pool. Reconnects on its own; the caller's backstop interval covers the gap.
 *
 * @param onEvent Called with the chain name that gained events.
 */
export function listenEvents(onEvent: (chain: string) => void): void {
  const connect = (): void => {
    const client = new pg.Client({ connectionString: databaseUrl });
    client.on("notification", (n) => onEvent(n.payload ?? ""));
    client.on("error", (e) => {
      log.warn(`listener: ${e.message}`);
      client.end().catch(() => {});
      setTimeout(connect, 5_000);
    });
    client
      .connect()
      .then(() => client.query(`LISTEN ${EVENTS_CHANNEL}`))
      .catch((e) => {
        log.warn(`listener: ${(e as Error).message}`);
        setTimeout(connect, 5_000);
      });
  };
  connect();
}

/** Events a reader has not seen yet, oldest first. */
export async function takeEvents(chain: string, after: bigint, limit: number): Promise<EventRow[]> {
  const r = await pool.query(
    `SELECT * FROM events WHERE chain = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
    [chain, after.toString(), limit],
  );
  return r.rows;
}

export async function readerSeq(name: string, chain: string): Promise<bigint> {
  const r = await pool.query(`SELECT seq FROM readers WHERE name = $1 AND chain = $2`, [
    name,
    chain,
  ]);
  return r.rows[0] ? BigInt(r.rows[0].seq) : 0n;
}

/** Advance a reader. Must run inside the same transaction as the writes it accounts for. */
export async function advanceReader(
  db: pg.PoolClient | pg.Pool,
  name: string,
  chain: string,
  seq: bigint,
): Promise<void> {
  await db.query(
    `INSERT INTO readers (name, chain, seq) VALUES ($1, $2, $3)
     ON CONFLICT (name, chain) DO UPDATE SET seq = EXCLUDED.seq`,
    [name, chain, seq.toString()],
  );
}

/** Park an event a reader cannot process, so one bad log never wedges the queue. */
export async function deadLetter(
  name: string,
  row: EventRow,
  error: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO dead_events (reader, chain, seq, tx_hash, log_index, error)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [name, row.chain, row.seq, row.tx_hash, row.log_index, error.slice(0, 2_000)],
  );
}

/**
 * Apply and clear a rebuild asked for a reader: empty its tables, drop its progress and its parked
 * events, all in one transaction. The drain runs it before draining, so nothing of its own is in
 * flight.
 *
 * @param name Reader name.
 * @param tables The tables it owns.
 * @returns Whether a rebuild was asked for.
 */
export async function applyRebuild(name: string, tables: string[]): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(`DELETE FROM rebuilds WHERE reader = $1`, [name]);
    if (!r.rowCount) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(`TRUNCATE ${tables.join(", ")}`);
    await client.query(`DELETE FROM readers WHERE name = $1`, [name]);
    await client.query(`DELETE FROM dead_events WHERE reader = $1`, [name]);
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Reader progress for /api/status. */
export async function readerState(name: string): Promise<Record<string, string>> {
  const r = await pool.query(`SELECT chain, seq FROM readers WHERE name = $1`, [name]);
  return Object.fromEntries(r.rows.map((x) => [x.chain, x.seq]));
}
