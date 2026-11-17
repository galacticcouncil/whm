import { pool } from "../../db";
import { NTT } from "../../deployments";
import { validLegs } from "../../flow";

import { orders } from "./flows";

const VALID = validLegs(orders, "o");

/**
 * The rail an order rides, joined on: its `seq` is the WETH manager's sequence, so scoping to that
 * manager is what stops another corridor's transfer from matching. `ingest` owns these tables; this
 * only reads them.
 */
const RAIL = `
  LEFT JOIN ntt_transfers n
    ON n.source_chain = 'hydration'
   AND n.source_manager = '${NTT.weth.hydration.manager.toLowerCase()}'
   AND n.manager_sequence = o.seq
`;

/**
 * Every column, the rail's, and where the order sits among its terms' orders: `tranches` counts
 * them, `tranche` is this one's place. One order is a swap, or a DCA's first tranche until the next.
 */
const COLUMNS = `
  o.*,
  n.vaa_id, n.digest, n.state AS rail_state, n.published AS rail_published,
  n.settled AS rail_settled,
  (SELECT COUNT(*)::int FROM intent_v2_orders x WHERE x.auth_path = o.auth_path) AS tranches,
  (SELECT COUNT(*)::int FROM intent_v2_orders x WHERE x.auth_path = o.auth_path AND x.seq <= o.seq) AS tranche
`;

/**
 * Newest first by when the order was published, not by when the row was written — a backfill writes
 * old orders late. A row whose published leg has not arrived yet sorts by write time until it does.
 */
const NEWEST = `COALESCE((o.published->>'blockTimestamp')::numeric,
                         EXTRACT(EPOCH FROM o.updated_at) * 1000) DESC`;

export interface OrderRow extends Record<string, unknown> {
  seq: string;
  state: string;
}

/**
 * Orders, newest first.
 *
 * @param filter `state` narrows to any of its states; `authPath` to one set of terms; `publishedAfter`
 *        (unix ms) to orders published since; `address` matches the caller, owner, deposit address,
 *        refund address, recipient, or either transaction.
 * @returns A page of orders and how many match.
 */
export async function listOrders(filter: {
  state?: string[];
  authPath?: string;
  publishedAfter?: number;
  address?: string;
  limit: number;
  offset: number;
}): Promise<{ items: OrderRow[]; total: number }> {
  const conds: string[] = [VALID];
  const params: unknown[] = [];

  if (filter.state?.length) {
    params.push(filter.state);
    conds.push(`o.state = ANY($${params.length})`);
  }
  if (filter.authPath) {
    params.push(filter.authPath.trim().toLowerCase());
    conds.push(`o.auth_path = $${params.length}`);
  }
  if (filter.publishedAfter !== undefined) {
    params.push(filter.publishedAfter);
    conds.push(`(o.published->>'blockTimestamp')::numeric > $${params.length}`);
  }
  if (filter.address) {
    params.push(filter.address.trim().toLowerCase());
    const n = params.length;
    conds.push(
      `(o.caller = $${n} OR o.owner = $${n} OR o.deposit_address = $${n} OR o.refund_to = $${n}
        OR lower(o.recipient) = $${n}
        OR lower(o.published->>'txHash') = $${n} OR lower(o.forwarded->>'txHash') = $${n})`,
    );
  }

  const where = `WHERE ${conds.join(" AND ")}`;
  const total = await pool.query(`SELECT COUNT(*)::int AS n FROM intent_v2_orders o ${where}`, params);
  params.push(filter.limit, filter.offset);
  const items = await pool.query(
    `SELECT ${COLUMNS} FROM intent_v2_orders o ${RAIL} ${where}
     ORDER BY ${NEWEST} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: items.rows, total: total.rows[0].n };
}

/**
 * One order by its `seq`.
 *
 * @param seq The order's NTT message id.
 * @returns The row, or null.
 */
export async function getOrder(seq: string): Promise<OrderRow | null> {
  const r = await pool.query(`SELECT ${COLUMNS} FROM intent_v2_orders o ${RAIL} WHERE o.seq = $1`, [seq]);
  return r.rows[0] ?? null;
}

export interface TermsRow {
  auth_path: string;
  terms: string;
  deadline: string;
  orders: number;
  /** The newest order of these terms. */
  seq: string;
  order_vaa: string;
  published_at: string;
}

/**
 * Every set of terms with a deadline after `deadlineAfter`, one row each, with its newest order.
 *
 * Whether a set of terms still has work is not known here — that is `A`'s balances on NEAR — so the
 * caller picks how far past their deadline terms stay listed.
 *
 * @param deadlineAfter Unix seconds.
 * @returns The terms, soonest deadline first.
 */
export async function listTerms(deadlineAfter: number): Promise<TermsRow[]> {
  const r = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (o.auth_path)
              o.auth_path, o.terms, o.deadline,
              (COUNT(*) OVER (PARTITION BY o.auth_path))::int AS orders,
              o.seq, o.order_vaa, o.published->>'blockTimestamp' AS published_at
         FROM intent_v2_orders o
        WHERE o.published IS NOT NULL AND o.deadline > $1
        ORDER BY o.auth_path, o.seq DESC
     ) t ORDER BY t.deadline, t.auth_path`,
    [deadlineAfter],
  );
  return r.rows;
}
