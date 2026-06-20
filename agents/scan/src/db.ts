import pg from "pg";

import log from "./logger";
import { databaseUrl } from "./config";

export const pool = new pg.Pool({ connectionString: databaseUrl });

/**
 * Core schema shared by every feature: a per-chain ingestion `cursors` table and a raw
 * `events` log. Features add their own tables via their `initSchema()`. `address` is the
 * emitting contract — the processor routes on (chain, address, topic0).
 */
const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS cursors (
  chain TEXT PRIMARY KEY,
  block_number BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  address TEXT NOT NULL,
  block_number BIGINT NOT NULL,
  topics TEXT[] NOT NULL,
  data TEXT NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  PRIMARY KEY (chain, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_events_pending ON events (ingested_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_events_block ON events (chain, block_number);
`;

export async function initCore(): Promise<void> {
  await pool.query(CORE_SCHEMA);
  log.info("db core ready");
}

export interface EventRow {
  chain: string;
  tx_hash: string;
  log_index: number;
  address: string;
  block_number: string;
  topics: string[];
  data: string;
  ingested_at: string;
  processed_at: string | null;
}

/**
 * Insert a raw event. Returns true if inserted, false if already seen.
 *
 * @param chain       chain name
 * @param txHash      transaction hash (synthetic `${blockHash}-${i}` for substrate EVM.Log)
 * @param logIndex    log index within the tx/block
 * @param address     emitting contract address
 * @param blockNumber block number
 * @param topics      indexed topics (topic0 = event signature)
 * @param data        ABI-encoded non-indexed data
 */
export async function insertEvent(
  chain: string,
  txHash: string,
  logIndex: number,
  address: string,
  blockNumber: bigint,
  topics: readonly string[],
  data: string,
): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO events (chain, tx_hash, log_index, address, block_number, topics, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [chain, txHash, logIndex, address.toLowerCase(), blockNumber.toString(), topics, data],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Pick up to `limit` unprocessed events in ingestion order, restricted to enabled chains. */
export async function takePendingEvents(limit: number, chains: string[]): Promise<EventRow[]> {
  const r = await pool.query(
    `SELECT * FROM events WHERE processed_at IS NULL AND chain = ANY($2)
     ORDER BY ingested_at ASC LIMIT $1`,
    [limit, chains],
  );
  return r.rows;
}

export async function markProcessed(chain: string, txHash: string, logIndex: number): Promise<void> {
  await pool.query(
    `UPDATE events SET processed_at = NOW() WHERE chain = $1 AND tx_hash = $2 AND log_index = $3`,
    [chain, txHash, logIndex],
  );
}

export async function loadCursor(chain: string): Promise<bigint | null> {
  const r = await pool.query(`SELECT block_number FROM cursors WHERE chain = $1`, [chain]);
  return r.rows[0] ? BigInt(r.rows[0].block_number) : null;
}

export async function saveCursor(chain: string, block: bigint): Promise<void> {
  await pool.query(
    `INSERT INTO cursors (chain, block_number) VALUES ($1, $2)
     ON CONFLICT (chain) DO UPDATE SET block_number = EXCLUDED.block_number`,
    [chain, block.toString()],
  );
}
