import { h160 } from "@galacticcouncil/common/utils";

import { pool } from "../../db";
import type { EventRef } from "../../types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  source_asset TEXT NOT NULL,
  source_chain TEXT NOT NULL,
  dest_asset TEXT,
  dest_chain TEXT,
  dest_chain_id INTEGER,
  sender TEXT,
  recipient TEXT NOT NULL,
  gross_amount NUMERIC,
  fee NUMERIC,
  net_amount NUMERIC NOT NULL,
  transfer_sequence TEXT,
  message_sequence TEXT,
  pending_id TEXT,
  initiated JSONB,
  completed JSONB,
  queued JSONB,
  fulfilled JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transfers_correlation ON transfers (source_asset, recipient, net_amount);
CREATE INDEX IF NOT EXISTS idx_transfers_state ON transfers (state);
CREATE INDEX IF NOT EXISTS idx_transfers_recipient ON transfers (recipient);
CREATE INDEX IF NOT EXISTS idx_transfers_updated_at ON transfers (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_pending ON transfers (pending_id) WHERE pending_id IS NOT NULL;

CREATE OR REPLACE FUNCTION bj_state_rank(s TEXT) RETURNS INT AS $$
  SELECT CASE s
    WHEN 'initiated' THEN 0
    WHEN 'queued' THEN 1
    WHEN 'completed' THEN 2
    WHEN 'fulfilled' THEN 3
    ELSE -1
  END;
$$ LANGUAGE SQL IMMUTABLE;
`;

export async function initSchema(): Promise<void> {
  await pool.query(SCHEMA);
}

export type TransferState = "initiated" | "completed" | "queued" | "fulfilled";

export interface TransferRow {
  id: string;
  state: TransferState;
  source_asset: string;
  source_chain: string;
  dest_asset: string | null;
  dest_chain: string | null;
  dest_chain_id: number | null;
  sender: string | null;
  recipient: string;
  gross_amount: string | null;
  fee: string | null;
  net_amount: string;
  transfer_sequence: string | null;
  message_sequence: string | null;
  pending_id: string | null;
  initiated: EventRef | null;
  completed: EventRef | null;
  queued: EventRef | null;
  fulfilled: EventRef | null;
  updated_at: string;
}

export interface TransferPatch {
  source_asset: string;
  source_chain: string;
  sender?: string;
  recipient: string;
  dest_asset?: string;
  dest_chain?: string;
  dest_chain_id?: number;
  net_amount: string;
  fee?: string;
  gross_amount?: string;
  transfer_sequence?: string;
  message_sequence?: string;
  pending_id?: string;
  initiated?: EventRef;
  completed?: EventRef;
  queued?: EventRef;
  fulfilled?: EventRef;
}

const PATCH_COLS = [
  "source_asset",
  "source_chain",
  "dest_asset",
  "dest_chain",
  "dest_chain_id",
  "sender",
  "recipient",
  "net_amount",
  "fee",
  "gross_amount",
  "transfer_sequence",
  "message_sequence",
  "pending_id",
  "initiated",
  "completed",
  "queued",
  "fulfilled",
] as const;

/** Upsert a transfer row. `state` monotonically advances via bj_state_rank. Returns row + whether created. */
export async function upsertTransfer(
  id: string,
  state: TransferState,
  patch: TransferPatch,
): Promise<{ row: TransferRow; created: boolean; previousState: TransferState | null }> {
  const p = patch as unknown as Record<string, unknown>;

  const values = PATCH_COLS.map((c) => p[c] ?? null);
  const placeholders = PATCH_COLS.map((_, i) => `$${i + 3}`).join(", ");

  const sql = `
    WITH prev AS (SELECT state FROM transfers WHERE id = $1)
    INSERT INTO transfers (id, state, ${PATCH_COLS.join(", ")}, updated_at)
    VALUES ($1, $2, ${placeholders}, NOW())
    ON CONFLICT (id) DO UPDATE SET
      state = CASE WHEN bj_state_rank(EXCLUDED.state) > bj_state_rank(transfers.state)
                   THEN EXCLUDED.state ELSE transfers.state END,
      source_chain = CASE WHEN transfers.source_chain = 'unknown'
                          THEN EXCLUDED.source_chain ELSE transfers.source_chain END,
      sender = COALESCE(transfers.sender, EXCLUDED.sender),
      dest_chain = COALESCE(EXCLUDED.dest_chain, transfers.dest_chain),
      dest_chain_id = COALESCE(EXCLUDED.dest_chain_id, transfers.dest_chain_id),
      dest_asset = COALESCE(EXCLUDED.dest_asset, transfers.dest_asset),
      gross_amount = COALESCE(EXCLUDED.gross_amount, transfers.gross_amount),
      fee = COALESCE(EXCLUDED.fee, transfers.fee),
      transfer_sequence = COALESCE(EXCLUDED.transfer_sequence, transfers.transfer_sequence),
      message_sequence = COALESCE(EXCLUDED.message_sequence, transfers.message_sequence),
      pending_id = COALESCE(EXCLUDED.pending_id, transfers.pending_id),
      initiated = COALESCE(EXCLUDED.initiated, transfers.initiated),
      completed = COALESCE(EXCLUDED.completed, transfers.completed),
      queued = COALESCE(EXCLUDED.queued, transfers.queued),
      fulfilled = COALESCE(EXCLUDED.fulfilled, transfers.fulfilled),
      updated_at = NOW()
    RETURNING transfers.*, (SELECT state FROM prev) AS previous_state
  `;

  const r = await pool.query(sql, [id, state, ...values]);
  const row = r.rows[0] as TransferRow & { previous_state: TransferState | null };
  const previousState = row.previous_state;
  return { row, created: previousState === null, previousState };
}

/** Find the oldest initiated transfer that has no delivery event yet. */
export async function findInitiated(
  sourceAsset: string,
  recipient: string,
  netAmount: string,
): Promise<string | null> {
  const r = await pool.query(
    `SELECT id FROM transfers
       WHERE lower(source_asset) = lower($1)
         AND lower(recipient) = lower($2)
         AND net_amount = $3::numeric
         AND initiated IS NOT NULL
         AND completed IS NULL
         AND queued IS NULL
         AND fulfilled IS NULL
       ORDER BY (initiated->>'blockNumber')::numeric ASC
       LIMIT 1`,
    [sourceAsset, recipient, netAmount],
  );
  return r.rows[0]?.id ?? null;
}

export async function findByPendingId(pendingId: string): Promise<string | null> {
  const r = await pool.query(
    `SELECT id FROM transfers WHERE pending_id = $1 AND fulfilled IS NULL LIMIT 1`,
    [pendingId],
  );
  return r.rows[0]?.id ?? null;
}

export interface AddressCandidates {
  sender: string | null;
  recipient: string[];
}

export function addressFilter(input: string): AddressCandidates {
  const s = input.trim();
  if (h160.isEvmAddress(s)) {
    const lower = s.toLowerCase();
    return { sender: lower, recipient: [lower] };
  }
  if (h160.isSs58Address(s)) {
    const lower = s.toLowerCase();
    return { sender: null, recipient: [lower] };
  }
  return { sender: null, recipient: [] };
}

export async function listTransfers(filter: {
  state?: TransferState;
  address?: AddressCandidates;
  asset?: string;
  limit: number;
  offset: number;
}): Promise<{ items: TransferRow[]; total: number }> {
  const conds: string[] = [];
  const params: unknown[] = [];

  if (filter.state) {
    params.push(filter.state);
    conds.push(`state = $${params.length}`);
  }

  if (filter.address) {
    const or: string[] = [];
    if (filter.address.sender) {
      params.push(filter.address.sender);
      or.push(`lower(sender) = $${params.length}`);
    }
    if (filter.address.recipient.length) {
      params.push(filter.address.recipient);
      or.push(`lower(recipient) = ANY($${params.length})`);
    }
    conds.push(or.length ? `(${or.join(" OR ")})` : "FALSE");
  }

  if (filter.asset) {
    params.push(filter.asset.toLowerCase());
    conds.push(`lower(source_asset) = $${params.length}`);
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const total = await pool.query(`SELECT COUNT(*)::int AS n FROM transfers ${where}`, params);
  params.push(filter.limit, filter.offset);
  const items = await pool.query(
    `SELECT * FROM transfers ${where} ORDER BY updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: items.rows, total: total.rows[0].n };
}

export async function getTransfer(id: string): Promise<TransferRow | null> {
  const r = await pool.query(`SELECT * FROM transfers WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function stateCounts(): Promise<Record<string, number>> {
  const r = await pool.query(`SELECT state, COUNT(*)::int AS n FROM transfers GROUP BY state`);
  const out: Record<string, number> = { initiated: 0, completed: 0, queued: 0, fulfilled: 0 };
  for (const row of r.rows) out[row.state] = row.n;
  return out;
}
