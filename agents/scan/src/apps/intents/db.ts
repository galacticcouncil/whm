import { pool } from "../../db";
import { validLegs } from "../../flow";
import { NTT } from "../../deployments";

import { orders } from "./flows";

/**
 * The rail an order rides, joined on. The order names the NTT manager's sequence and nothing else,
 * so scoping to the manager that carries intents is what stops a sequence from another corridor
 * matching. `ingest` owns these tables; this only ever reads them.
 */
const RAIL = `
  LEFT JOIN ntt_transfers n
    ON n.source_chain = 'hydration'
   AND n.source_manager = '${NTT.weth.hydration.manager}'
   AND n.manager_sequence = o.transfer_sequence
  LEFT JOIN wh_messages m ON m.vaa_id = n.vaa_id
`;

const COLUMNS = `
  o.*,
  n.vaa_id, n.digest, n.state AS rail_state, n.published AS rail_published,
  n.received AS rail_received, n.settled AS rail_settled,
  m.sequence AS wormhole_sequence, m.consistency AS wormhole_consistency
`;

const VALID = validLegs(orders, "o");

/**
 * Newest first by when the order was placed, not by when we happened to write the row. Chains are
 * indexed in parallel and at different speeds, so `updated_at` reflects the backfill's progress
 * rather than anything a reader cares about; the placed leg's block time is the order's real age.
 * A row whose source leg has not arrived yet sorts by write time until it does.
 */
const NEWEST = `COALESCE((o.placed->>'blockTimestamp')::numeric,
                         EXTRACT(EPOCH FROM o.updated_at) * 1000) DESC`;

export interface OrderRow extends Record<string, unknown> {
  transfer_sequence: string;
  state: string;
}

/**
 * Recent orders, newest first.
 *
 * @param filter `state` narrows the lifecycle; `address` matches the caller, the Ethereum deposit
 *        address, or the final destination recipient.
 */
export async function listOrders(filter: {
  state?: string;
  address?: string;
  limit: number;
  offset: number;
}): Promise<{ items: OrderRow[]; total: number }> {
  const conds: string[] = [VALID];
  const params: unknown[] = [];

  if (filter.state) {
    params.push(filter.state);
    conds.push(`o.state = $${params.length}`);
  }
  if (filter.address) {
    params.push(filter.address.toLowerCase());
    conds.push(
      `(lower(o.caller) = $${params.length} OR lower(o.deposit_address) = $${params.length} OR lower(o.dest_address) = $${params.length})`,
    );
  }

  const where = `WHERE ${conds.join(" AND ")}`;
  const total = await pool.query(
    `SELECT COUNT(*)::int AS n FROM intent_orders o ${where}`,
    params,
  );
  params.push(filter.limit, filter.offset);
  const items = await pool.query(
    `SELECT ${COLUMNS} FROM intent_orders o ${RAIL} ${where}
     ORDER BY ${NEWEST} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: items.rows, total: total.rows[0].n };
}

export async function getOrder(sequence: string): Promise<OrderRow | null> {
  const r = await pool.query(
    `SELECT ${COLUMNS} FROM intent_orders o ${RAIL} WHERE o.transfer_sequence = $1`,
    [sequence],
  );
  return r.rows[0] ?? null;
}

/**
 * Orders whose off-chain leg is not finished — the settlement poller's work set.
 *
 * `placed` is in it as well as `processed`, and deliberately: the deposit address derives from a
 * quote that already names the destination asset, recipient and expected output, so all of that is
 * knowable the moment the order exists rather than only once Ethereum has forwarded. Waiting for
 * `processed` would leave an in-flight order showing no destination at all — which is exactly when
 * someone is looking.
 *
 * A terminal state drops out of the set, so polling stops on its own.
 */
export async function pendingSettlement(): Promise<
  {
    transfer_sequence: string;
    state: string;
    deposit_address: string;
    settlement_status: string | null;
  }[]
> {
  const r = await pool.query(
    `SELECT transfer_sequence, state, deposit_address, settlement_status FROM intent_orders
      WHERE state IN ('placed', 'processed') AND deposit_address IS NOT NULL`,
  );
  return r.rows;
}

export async function listQuotes(limit: number, offset: number) {
  const total = await pool.query(`SELECT COUNT(*)::int AS n FROM intent_quotes`);
  const items = await pool.query(
    `SELECT * FROM intent_quotes ORDER BY updated_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return { items: items.rows, total: total.rows[0].n };
}

export async function getQuote(authPath: string) {
  const r = await pool.query(`SELECT * FROM intent_quotes WHERE lower(auth_path) = lower($1)`, [
    authPath,
  ]);
  return r.rows[0] ?? null;
}
