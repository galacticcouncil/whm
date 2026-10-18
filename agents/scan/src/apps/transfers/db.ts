import { pad } from "viem";

import { WORMHOLE_CHAINS } from "../../chains";
import { pool } from "../../db";
import { validLegs } from "../../flow";
import { bytes32ToAddress, normalizeRecipient } from "../../utils";
import { INTENT } from "../../deployments";

import { basejump } from "./basejump/flows";
import { BASEJUMP_ASSETS, nttSymbol } from "./tokens";
import { byChain } from "./utxo/routes";

/** The kinds of transfer, by the rail that carries them. */
export type Kind = "ntt" | "utxo" | "basejump";

/** What the list says about a transfer, whichever rail it rode. */
export interface TransferView {
  id: string;
  kind: Kind;
  /** `transfer`, `intent`, `deposit`, `withdraw`, `basejump`. */
  type: string;
  /** When it was sent, unix ms. */
  time: number | null;
  from_chain: string;
  from_address: string | null;
  to_chain: string;
  to_address: string | null;
  symbol: string | null;
  decimals: number | null;
  amount: string | null;
  fee: string | null;
  /** `pending`, `held`, `completed`, `failed`. */
  status: string;
  /** Where along its route it is — the rail's own state. */
  stage: string;
}

const INTENT_SENDER = pad(INTENT.emitter.toLowerCase() as `0x${string}`, { size: 32 });

/**
 * The sign a withdrawal was paid out under: the first for its account after NEAR delivered to it.
 * One sign takes the whole balance, so it may cover several withdrawals.
 */
const SIGN = `
  LEFT JOIN LATERAL (
    SELECT s.* FROM utxo_signs s
     WHERE u.direction = 'withdraw' AND s.account = u.near_account AND s.action = 'withdraw'
       AND (s.signed->>'blockTimestamp')::bigint >= (n.settled->>'blockTimestamp')::bigint
     ORDER BY (s.signed->>'blockTimestamp')::bigint LIMIT 1
  ) s ON TRUE`;

/**
 * Every transfer, in one shape. A UTXO transfer rides NTT, so NTT lists only what no other rail
 * claims; amounts stay raw, and the chain-specific parts — symbols, addresses — are finished in
 * `present`.
 */
const UNION = `
  SELECT 'ntt:' || n.digest AS id, 'ntt' AS kind,
         CASE WHEN n.sender = '${INTENT_SENDER}' THEN 'intent' ELSE 'transfer' END AS type,
         COALESCE((n.published->>'blockTimestamp')::bigint, (n.settled->>'blockTimestamp')::bigint) AS time,
         n.source_chain AS from_chain, COALESCE(n.sender_account, n.sender) AS from_address,
         n.to_chain::text AS to_chain, COALESCE(n.recipient_account, n.recipient) AS to_address,
         n.source_manager AS token, n.amount, n.decimals, NULL::numeric AS fee,
         CASE n.state WHEN 'redeemed' THEN 'completed' WHEN 'queued' THEN 'held' ELSE 'pending' END AS status,
         n.state AS stage
    FROM ntt_transfers n
   WHERE n.published IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM utxo_transfers u WHERE u.digest = n.digest)
  UNION ALL
  SELECT 'utxo:' || u.id, 'utxo', u.direction,
         (COALESCE(u.requested, u.deposited)->>'blockTimestamp')::bigint,
         CASE u.direction WHEN 'deposit' THEN u.chain ELSE 'hydration' END,
         -- A deposit's sender is who the order names to refund, not whichever coins the wallet spent.
         CASE u.direction WHEN 'deposit' THEN COALESCE(u.refund_address, u.sender) ELSE u.sender END,
         CASE u.direction WHEN 'deposit' THEN 'hydration' ELSE u.chain END, u.recipient,
         u.chain, COALESCE(n.amount, u.amount), NULL, u.fee,
         CASE WHEN u.deposit_ok = false THEN 'failed'
              WHEN u.direction = 'deposit' AND n.state = 'redeemed' THEN 'completed'
              WHEN u.state = 'confirmed' THEN 'completed'
              WHEN n.state = 'queued' THEN 'held'
              ELSE 'pending' END,
         CASE WHEN u.direction = 'deposit' THEN COALESCE(n.state, 'deposited')
              WHEN u.state IN ('withdrawn', 'confirmed') THEN u.state
              WHEN s.id IS NOT NULL THEN 'signed'
              WHEN n.state = 'redeemed' THEN 'received'
              ELSE 'requested' END
    FROM utxo_transfers u LEFT JOIN ntt_transfers n ON n.digest = u.digest
    ${SIGN}
  UNION ALL
  SELECT 'basejump:' || b.id, 'basejump', 'basejump',
         COALESCE((b.initiated->>'blockTimestamp')::bigint, (b.completed->>'blockTimestamp')::bigint),
         COALESCE(b.source_chain, 'ethereum'), b.sender, COALESCE(b.dest_chain, 'hydration'), b.recipient,
         b.source_asset, b.net_amount, NULL, b.fee,
         CASE WHEN b.state IN ('completed', 'fulfilled') THEN 'completed'
              WHEN b.state = 'queued' THEN 'held' ELSE 'pending' END,
         b.state
    FROM basejump_transfers b
   WHERE ${validLegs(basejump, "b")}
`;

/**
 * Recent transfers, newest first.
 *
 * @param filter `type` and `status` narrow the list; `address` matches either end, as typed — an EVM
 *        address also as the 32 bytes NTT carries it in.
 */
export async function listTransfers(filter: {
  type?: string;
  status?: string;
  address?: string;
  limit: number;
  offset: number;
}): Promise<{ items: TransferView[]; total: number }> {
  const conds: string[] = [];
  const params: unknown[] = [];

  if (filter.type) {
    params.push(filter.type);
    conds.push(`type = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    conds.push(`status = $${params.length}`);
  }
  if (filter.address) {
    const a = filter.address.trim().toLowerCase();
    const forms = /^0x[0-9a-f]{40}$/.test(a) ? [a, pad(a as `0x${string}`, { size: 32 })] : [a];
    params.push(forms);
    conds.push(
      `(lower(from_address) = ANY($${params.length}) OR lower(to_address) = ANY($${params.length}))`,
    );
  }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const total = await pool.query(`SELECT COUNT(*)::int AS n FROM (${UNION}) t ${where}`, params);
  params.push(filter.limit, filter.offset);
  const items = await pool.query(
    `SELECT * FROM (${UNION}) t ${where}
      ORDER BY time DESC NULLS LAST, id LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: items.rows.map(present), total: total.rows[0].n };
}

/**
 * One transfer: the list's view of it, and its rail's own row — the NTT transfer beside a UTXO or
 * Basejump one where there is one.
 *
 * @param id `<kind>:<key>`.
 */
export async function getTransfer(
  id: string,
): Promise<{ view: TransferView; record: Record<string, unknown> } | null> {
  const v = await pool.query(`SELECT * FROM (${UNION}) t WHERE id = $1`, [id]);
  if (!v.rows[0]) return null;
  const view = present(v.rows[0]);
  const key = id.slice(id.indexOf(":") + 1);

  const RAIL = `n.vaa_id, n.digest AS rail_digest, n.state AS rail_state, n.amount AS rail_amount,
                n.decimals AS rail_decimals, n.published AS rail_published, n.received AS rail_received,
                n.settled AS rail_settled, n.recipient_account, m.consistency AS wormhole_consistency`;
  const sql: Record<Kind, string> = {
    ntt: `SELECT n.*, m.consistency AS wormhole_consistency FROM ntt_transfers n
            LEFT JOIN wh_messages m ON m.vaa_id = n.vaa_id WHERE n.digest = $1`,
    utxo: `SELECT u.*, ${RAIL}, s.signed AS sign, s.amount AS sign_amount, s.input AS sign_input
             FROM utxo_transfers u
             LEFT JOIN ntt_transfers n ON n.digest = u.digest
             LEFT JOIN wh_messages m ON m.vaa_id = n.vaa_id
             ${SIGN}
            WHERE u.id = $1`,
    basejump: `SELECT * FROM basejump_transfers WHERE id = $1`,
  };
  const r = await pool.query(sql[view.kind], [key]);
  return { view, record: r.rows[0] ?? {} };
}

/**
 * Finish a row: chain names for Wormhole ids, readable addresses for the 32 bytes NTT carries, and
 * the token's symbol and precision.
 *
 * @param r A row of `UNION`.
 */
function present(r: Record<string, any>): TransferView {
  const toChain =
    r.kind === "ntt" ? (WORMHOLE_CHAINS[Number(r.to_chain)] ?? r.to_chain) : r.to_chain;
  let symbol: string | null = null;
  let decimals: number | null = r.decimals;
  if (r.kind === "ntt") symbol = nttSymbol(r.token);
  if (r.kind === "utxo")
    ({ symbol, decimals } = byChain(r.token) ?? { symbol: null, decimals: null });
  if (r.kind === "basejump")
    ({ symbol, decimals } = BASEJUMP_ASSETS[r.token] ?? { symbol: null, decimals: null });

  return {
    id: r.id,
    kind: r.kind,
    type: r.type,
    time: r.time === null ? null : Number(r.time),
    from_chain: r.from_chain,
    from_address: readable(r.from_chain, r.from_address),
    to_chain: toChain,
    to_address: readable(toChain, r.to_address),
    symbol,
    decimals,
    amount: r.amount,
    fee: r.fee,
    status: r.status,
    stage: r.stage,
  };
}

/**
 * An address as its own chain writes it. NTT carries 32 bytes: an EVM address left-padded, a
 * Hydration account either padded or whole, a NEAR account hashed — which stays a hash until the
 * delivery names it.
 *
 * @param chain The chain it is on.
 * @param v The address, as stored.
 */
function readable(chain: string, v: string | null): string | null {
  if (!v || !/^0x[0-9a-f]{64}$/i.test(v)) return v;
  if (chain === "near") return v;
  if (/^0x0{24}/i.test(v)) return bytes32ToAddress(v);
  return chain === "hydration" ? normalizeRecipient(v) : v;
}
