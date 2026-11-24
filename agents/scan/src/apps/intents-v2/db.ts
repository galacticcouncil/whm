import { pool } from "../../db";
import { NTT } from "../../deployments";
import { validLegs } from "../../flow";

import { orders } from "./flows";

const VALID = validLegs(orders, "o");

/** wNEAR's intents ledger id — the router withdraws it as native NEAR, paid on NEAR itself. */
const WNEAR = "nep141:wrap.near";

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
 * Every column, the rail's, and where the order sits among its trade's orders: `order_count` counts
 * them, `order_index` is this one's place, from 1, and `trade_planned` is how many its ICE intent was
 * submitted for.
 */
const COLUMNS = `
  o.*,
  n.vaa_id, n.digest, n.state AS rail_state, n.published AS rail_published,
  n.settled AS rail_settled,
  (SELECT COUNT(*)::int FROM intent_v2_orders x WHERE x.auth_path = o.auth_path) AS order_count,
  (SELECT COUNT(*)::int FROM intent_v2_orders x WHERE x.auth_path = o.auth_path AND x.seq <= o.seq) AS order_index,
  (SELECT MAX(i.planned) FROM intent_v2_ice i WHERE i.auth_path = o.auth_path) AS trade_planned
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
  /** Unix seconds — the earliest a close of these terms lets anyone settle; null while open. */
  settle_at: string | null;
  /** The newest close whose countdown has passed — what `settle` takes; null until one has. */
  close_vaa: string | null;
}

/**
 * The closes of each trade: the earliest countdown end — every close message stays valid, so the
 * soonest one counts — and the newest close already past its countdown, the one most likely to
 * still verify after a guardian set rotation.
 */
const CLOSES = `
  SELECT c.auth_path, MIN(c.settle_at) AS settle_at,
         (ARRAY_AGG(c.close_vaa ORDER BY c.message_sequence DESC)
            FILTER (WHERE c.settle_at <= EXTRACT(EPOCH FROM now())))[1] AS close_vaa
    FROM intent_v2_closes c
   GROUP BY c.auth_path
`;

/** Every set of terms, one row each, with its newest order and its closes — what the router bot works from. */
const TERMS = `
  SELECT t.*, c.settle_at, c.close_vaa
    FROM (
      SELECT DISTINCT ON (o.auth_path)
             o.auth_path, o.terms, o.deadline,
             (COUNT(*) OVER (PARTITION BY o.auth_path))::int AS orders,
             o.seq, o.order_vaa, o.published->>'blockTimestamp' AS published_at
        FROM intent_v2_orders o
       WHERE o.published IS NOT NULL
       ORDER BY o.auth_path, o.seq DESC
    ) t
    LEFT JOIN (${CLOSES}) c ON c.auth_path = t.auth_path
`;

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
    `SELECT * FROM (${TERMS}) t WHERE t.deadline > $1 ORDER BY t.deadline, t.auth_path`,
    [deadlineAfter],
  );
  return r.rows;
}

/**
 * The payouts of one set of terms, oldest first — deliveries and refunds, with where each landed
 * once the poller has found it.
 *
 * @param authPath The terms' `auth_path`.
 * @returns Their payouts.
 */
export async function listPayouts(authPath: string): Promise<Record<string, unknown>[]> {
  const r = await pool.query(
    `SELECT * FROM intent_v2_payouts WHERE auth_path = $1
      ORDER BY (signed->>'blockTimestamp')::numeric`,
    [authPath.trim().toLowerCase()],
  );
  return r.rows;
}

export interface UtxoPayoutRow {
  id: string;
  auth_path: string;
  amount: string;
  /** Intents ledger id, e.g. `nep141:zec.omft.near`. */
  token: string;
  /** The address on the coin's chain. */
  receiver: string;
  utxo_account: string;
  /** Unix ms. */
  signed_at: string;
}

/**
 * Deliveries the router sent to an `A_utxo`, signed at or after `afterMs`, oldest first — what the
 * UTXO relayer withdraws to the coin's own chain. Inclusive, so a reader resuming from its last
 * timestamp sees rows of the same millisecond again; it keys them by `id`.
 *
 * @param afterMs Unix ms.
 * @param limit Page size.
 * @returns The deliveries.
 */
export async function listUtxoPayouts(afterMs: number, limit: number): Promise<UtxoPayoutRow[]> {
  const r = await pool.query(
    `SELECT id, auth_path, amount, token, receiver, utxo_account, signed->>'blockTimestamp' AS signed_at
       FROM intent_v2_payouts
      WHERE utxo_account IS NOT NULL AND (signed->>'blockTimestamp')::numeric >= $1
      ORDER BY (signed->>'blockTimestamp')::numeric, id
      LIMIT $2`,
    [afterMs, limit],
  );
  return r.rows;
}

/**
 * Trades — one set of terms each, the user's whole cross-chain swap: a swap is a trade of one order, a
 * TWAP of several. The terms' fields come from its newest order (every order of a trade carries the
 * same terms); the rest is counted over its orders and payouts.
 *
 * - `sold`: the ETH that reached `A` less any refunded — every fill sells `A`'s whole ETH, so what is
 *   not refunded was sold. Orders `execute` placed also carry what the user sold on Hydration for it
 *   (`asset_in`, `amount_in`).
 * - `received`: what arrived — for a withdrawal, what landed on the recipient's chain once found;
 *   for an intents recipient, or NEAR withdrawn as native NEAR, the delivery itself, paid on NEAR
 *   with no fee.
 * - `planned`: how many orders its ICE intent was submitted for (`intent_v2_ice`); null for a
 *   direct `dispatch`, or a DCA without a budget.
 * - `settle_at`, `close_vaa`: from the owner's closes (`intent_v2_closes`), as for `/api/terms`.
 * - `status`: `refunded` once a refund was signed; `completed` once every planned order is swapped —
 *   or, with no planned count to go by, the deadline or a close's countdown has passed — and a
 *   delivery was signed after the last swap, which emptied `A`; `closing` once closed, until then;
 *   `expired` past the deadline with nothing paid out; else `pending`.
 */
const TRADES = `
  SELECT t.*, p.delivered, p.received, p.refunded, p.payouts, c.settle_at, c.close_vaa,
         t.eth_in - p.refunded_amount AS sold,
         CASE WHEN p.refunded THEN 'refunded'
              WHEN t.swapped > 0 AND p.last_delivered_at >= t.last_swapped_at
                   AND (t.swapped >= t.planned
                        OR LEAST(t.deadline, c.settle_at) * 1000 <= EXTRACT(EPOCH FROM now()) * 1000)
                THEN 'completed'
              WHEN c.settle_at IS NOT NULL THEN 'closing'
              WHEN t.deadline * 1000 <= EXTRACT(EPOCH FROM now()) * 1000 AND p.payouts = 0 THEN 'expired'
              ELSE 'pending' END AS status
    FROM (
      SELECT DISTINCT ON (o.auth_path)
             o.auth_path, o.terms, o.owner, o.caller, o.destination_asset, o.recipient,
             o.recipient_kind, o.refund_to, o.deadline,
             (COUNT(*) OVER w)::int AS order_count,
             (COUNT(o.swapped) OVER w)::int AS swapped,
             SUM(COALESCE(o.forwarded_amount, o.amount)) OVER w AS eth_in,
             MAX(o.asset_in) OVER w AS asset_in,
             SUM(o.amount_in) OVER w AS amount_in,
             MIN((o.published->>'blockTimestamp')::numeric) OVER w AS first_at,
             MAX((o.published->>'blockTimestamp')::numeric) OVER w AS last_at,
             MAX((o.swapped->>'blockTimestamp')::numeric) OVER w AS last_swapped_at,
             (SELECT MAX(i.planned) FROM intent_v2_ice i WHERE i.auth_path = o.auth_path) AS planned
        FROM intent_v2_orders o
       WHERE ${VALID} AND o.published IS NOT NULL
      WINDOW w AS (PARTITION BY o.auth_path)
       ORDER BY o.auth_path, o.seq DESC
    ) t
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(x.amount) FILTER (WHERE x.state = 'delivered'), 0) AS delivered,
             COALESCE(SUM(CASE WHEN t.recipient_kind = 1 OR t.destination_asset = '${WNEAR}'
                               THEN x.amount ELSE x.dest_amount END)
                        FILTER (WHERE x.state = 'delivered'), 0) AS received,
             COALESCE(SUM(x.amount) FILTER (WHERE x.state = 'refunded'), 0) AS refunded_amount,
             COALESCE(BOOL_OR(x.state = 'refunded'), false) AS refunded,
             MAX((x.signed->>'blockTimestamp')::numeric) FILTER (WHERE x.state = 'delivered') AS last_delivered_at,
             COUNT(*)::int AS payouts
        FROM intent_v2_payouts x WHERE x.auth_path = t.auth_path
    ) p ON true
    LEFT JOIN (${CLOSES}) c ON c.auth_path = t.auth_path
`;

/**
 * Trades, newest activity first.
 *
 * @param filter `status` narrows to any of its statuses; `address` matches the caller, owner,
 *        refund address or recipient.
 * @returns A page of trades and how many match.
 */
export async function listTrades(filter: {
  status?: string[];
  address?: string;
  limit: number;
  offset: number;
}): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const conds: string[] = ["TRUE"];
  const params: unknown[] = [];
  if (filter.status?.length) {
    params.push(filter.status);
    conds.push(`q.status = ANY($${params.length})`);
  }
  if (filter.address) {
    params.push(filter.address.trim().toLowerCase());
    const n = params.length;
    conds.push(`(q.caller = $${n} OR q.owner = $${n} OR q.refund_to = $${n} OR lower(q.recipient) = $${n})`);
  }
  const where = `WHERE ${conds.join(" AND ")}`;
  const total = await pool.query(`SELECT COUNT(*)::int AS n FROM (${TRADES}) q ${where}`, params);
  params.push(filter.limit, filter.offset);
  const items = await pool.query(
    `SELECT * FROM (${TRADES}) q ${where}
      ORDER BY q.last_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: items.rows, total: total.rows[0].n };
}

/**
 * One trade whole: its terms and status, every order of it, every payout.
 *
 * @param authPath The terms' `auth_path`.
 * @returns The trade, or null.
 */
export async function getTrade(
  authPath: string,
): Promise<{ trade: Record<string, unknown>; orders: OrderRow[]; payouts: Record<string, unknown>[] } | null> {
  const path = authPath.trim().toLowerCase();
  const trade = (await pool.query(`SELECT * FROM (${TRADES}) q WHERE q.auth_path = $1`, [path])).rows[0];
  if (!trade) return null;
  const orders = await pool.query(
    `SELECT ${COLUMNS} FROM intent_v2_orders o ${RAIL} WHERE o.auth_path = $1 AND ${VALID} ORDER BY o.seq`,
    [path],
  );
  return { trade, orders: orders.rows, payouts: await listPayouts(path) };
}
