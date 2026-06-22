import { pool } from "../../db";
import type { EventRef } from "../../types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS intents (
  intent_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  caller TEXT,
  asset_in BIGINT,
  amount_in NUMERIC,
  eth_out NUMERIC,
  deposit_address TEXT,
  wormhole_sequence TEXT,
  max_relay_fee NUMERIC,
  forwarded_asset TEXT,
  forwarded_amount NUMERIC,
  relay_fee NUMERIC,
  relayer TEXT,
  settlement_status TEXT,
  emitted JSONB,
  published JSONB,
  forwarded JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_intents_state ON intents (state);
CREATE INDEX IF NOT EXISTS idx_intents_deposit ON intents (deposit_address);
CREATE INDEX IF NOT EXISTS idx_intents_updated_at ON intents (updated_at DESC);

CREATE OR REPLACE FUNCTION intent_state_rank(s TEXT) RETURNS INT AS $$
  SELECT CASE s
    WHEN 'emitted' THEN 0
    WHEN 'published' THEN 1
    WHEN 'forwarded' THEN 2
    WHEN 'succeeded' THEN 3
    WHEN 'refunded' THEN 3
    WHEN 'failed' THEN 3
    ELSE -1
  END;
$$ LANGUAGE SQL IMMUTABLE;
`;

export async function initSchema(): Promise<void> {
  await pool.query(SCHEMA);
}

export type IntentState =
  | "emitted"
  | "published"
  | "forwarded"
  | "succeeded"
  | "refunded"
  | "failed";

export interface IntentRow {
  intent_id: string;
  state: IntentState;
  caller: string | null;
  asset_in: string | null;
  amount_in: string | null;
  eth_out: string | null;
  deposit_address: string | null;
  wormhole_sequence: string | null;
  max_relay_fee: string | null;
  forwarded_asset: string | null;
  forwarded_amount: string | null;
  relay_fee: string | null;
  relayer: string | null;
  settlement_status: string | null;
  emitted: EventRef | null;
  published: EventRef | null;
  forwarded: EventRef | null;
  updated_at: string;
}

export interface IntentPatch {
  caller?: string;
  asset_in?: number;
  amount_in?: string;
  eth_out?: string;
  deposit_address?: string;
  wormhole_sequence?: string;
  max_relay_fee?: string;
  forwarded_asset?: string;
  forwarded_amount?: string;
  relay_fee?: string;
  relayer?: string;
  settlement_status?: string;
  emitted?: EventRef;
  published?: EventRef;
  forwarded?: EventRef;
}

const PATCH_COLS = [
  "caller",
  "asset_in",
  "amount_in",
  "eth_out",
  "deposit_address",
  "wormhole_sequence",
  "max_relay_fee",
  "forwarded_asset",
  "forwarded_amount",
  "relay_fee",
  "relayer",
  "settlement_status",
  "emitted",
  "published",
  "forwarded",
] as const;

/**
 * Upsert an intent row keyed by `intentId`. State advances monotonically via intent_state_rank;
 * every other column is filled via COALESCE so out-of-order legs merge cleanly.
 *
 * @param id    the intentId (lowercased hex)
 * @param state lifecycle state this event represents
 * @param patch columns to set/merge
 */
export async function upsertIntent(
  id: string,
  state: IntentState,
  patch: IntentPatch,
): Promise<{ row: IntentRow; created: boolean; previousState: IntentState | null }> {
  const p = patch as unknown as Record<string, unknown>;
  const values = PATCH_COLS.map((c) => p[c] ?? null);
  const placeholders = PATCH_COLS.map((_, i) => `$${i + 3}`).join(", ");
  const updates = PATCH_COLS.map((c) => `${c} = COALESCE(EXCLUDED.${c}, intents.${c})`).join(",\n      ");

  const sql = `
    WITH prev AS (SELECT state FROM intents WHERE intent_id = $1)
    INSERT INTO intents (intent_id, state, ${PATCH_COLS.join(", ")}, updated_at)
    VALUES ($1, $2, ${placeholders}, NOW())
    ON CONFLICT (intent_id) DO UPDATE SET
      state = CASE WHEN intent_state_rank(EXCLUDED.state) > intent_state_rank(intents.state)
                   THEN EXCLUDED.state ELSE intents.state END,
      ${updates},
      updated_at = NOW()
    RETURNING intents.*, (SELECT state FROM prev) AS previous_state
  `;

  const r = await pool.query(sql, [id, state, ...values]);
  const row = r.rows[0] as IntentRow & { previous_state: IntentState | null };
  return { row, created: row.previous_state === null, previousState: row.previous_state };
}

export async function listIntents(filter: {
  state?: IntentState;
  depositAddress?: string;
  limit: number;
  offset: number;
}): Promise<{ items: IntentRow[]; total: number }> {
  const conds: string[] = [];
  const params: unknown[] = [];

  if (filter.state) {
    params.push(filter.state);
    conds.push(`state = $${params.length}`);
  }
  if (filter.depositAddress) {
    params.push(filter.depositAddress.toLowerCase());
    conds.push(`lower(deposit_address) = $${params.length}`);
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const total = await pool.query(`SELECT COUNT(*)::int AS n FROM intents ${where}`, params);
  params.push(filter.limit, filter.offset);
  const items = await pool.query(
    `SELECT * FROM intents ${where} ORDER BY updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: items.rows, total: total.rows[0].n };
}

export async function getIntent(id: string): Promise<IntentRow | null> {
  const r = await pool.query(`SELECT * FROM intents WHERE lower(intent_id) = lower($1)`, [id]);
  return r.rows[0] ?? null;
}

/** Forwarded intents still awaiting OneClick settlement — the settlement poller's work set. */
export async function forwardedPendingSettlement(): Promise<
  { intent_id: string; deposit_address: string; settlement_status: string | null }[]
> {
  const r = await pool.query(
    `SELECT intent_id, deposit_address, settlement_status FROM intents
       WHERE state = 'forwarded' AND deposit_address IS NOT NULL`,
  );
  return r.rows;
}

export async function stateCounts(): Promise<Record<string, number>> {
  const r = await pool.query(`SELECT state, COUNT(*)::int AS n FROM intents GROUP BY state`);
  const out: Record<string, number> = { emitted: 0, published: 0, forwarded: 0 };
  for (const row of r.rows) out[row.state] = row.n;
  return out;
}
