import type { Flow, LogEvent, Queryable } from "../../../types";
import { normalizeRecipient } from "../../../utils";

import {
  BridgeInitiatedEvt,
  ParkedTransferFulfilledEvt,
  PendingTransferFulfilledEvt,
  TransferExecutedEvt,
  TransferParkedEvt,
  TransferQueuedEvt,
} from "./abi";

interface Initiated {
  asset: `0x${string}`;
  amount: bigint;
  fee: bigint;
  destChain: number;
  recipient: `0x${string}`;
  transferSequence: bigint;
  messageSequence: bigint;
}

interface Delivery {
  sourceAsset: `0x${string}`;
  destAsset: `0x${string}`;
  recipient: `0x${string}`;
  amount: bigint;
}

type Queued = Delivery & { id: bigint };

/**
 * A landing's pending-queue id, namespaced by the landing. Two independent deployments each run
 * their own counter, so the address is what keeps their ids apart.
 */
const pendingKey = (ev: LogEvent, id: bigint) => `${ev.address.toLowerCase()}:${id}`;

/**
 * A delivery that matched nothing. Kept rather than dropped — its source may not be read yet, and
 * adopts it when it is — but it has no `initiated`, so the orphan rule keeps it out of the list.
 */
const orphan = (ev: LogEvent, kind: string) =>
  `orphan-${kind}-${ev.chain}-${ev.ref.txHash}-${ev.ref.logIndex}`;

/**
 * A source's row: its own key, taking over the oldest orphan delivery it pays for.
 *
 * The fast path can pay out before the source chain is read — its VAA is instant, the source is
 * read behind its head — and that payout found no source, so it waits as an orphan. Renaming the
 * orphan to the source's key lets the source's patch merge into it, payout and all.
 *
 * @param db The drain's transaction.
 * @param id The source's key.
 */
async function adoptOrphan(
  db: Queryable,
  id: string,
  sourceAsset: string,
  recipient: string,
  netAmount: string,
): Promise<string> {
  await db.query(
    `UPDATE basejump_transfers SET id = $1
      WHERE id = (SELECT id FROM basejump_transfers
                   WHERE (id LIKE 'orphan-exec-%' OR id LIKE 'orphan-queue-%')
                     AND initiated IS NULL
                     AND lower(source_asset) = lower($2)
                     AND lower(recipient) = lower($3)
                     AND net_amount = $4::numeric
                   ORDER BY COALESCE((completed->>'blockNumber')::numeric, (queued->>'blockNumber')::numeric)
                   LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM basejump_transfers WHERE id = $1)`,
    [id, sourceAsset, recipient, netAmount],
  );
  return id;
}

/**
 * Match a delivery to the oldest source still awaiting one.
 *
 * The landing events carry no sequence, so the source and the payout share nothing but the asset,
 * the recipient and the amount — correlation here is a lookup rather than a key, which is why it
 * runs against the drain's own transaction and sees whatever the batch has already written.
 *
 * @param db The drain's transaction.
 */
async function findInitiated(
  db: Queryable,
  sourceAsset: string,
  recipient: string,
  netAmount: string,
): Promise<string | null> {
  const r = await db.query(
    `SELECT id FROM basejump_transfers
       WHERE lower(source_asset) = lower($1)
         AND lower(recipient) = lower($2)
         AND net_amount = $3::numeric
         AND initiated IS NOT NULL
         AND completed IS NULL AND queued IS NULL AND fulfilled IS NULL
       ORDER BY (initiated->>'blockNumber')::numeric ASC
       LIMIT 1`,
    [sourceAsset, recipient, netAmount],
  );
  return r.rows[0]?.id ?? null;
}

/**
 * The row a queue-id event belongs to: the one the queued leg tagged with this id, still without
 * `column`. The queue id is exact, so these legs need no heuristic.
 */
const byPendingId =
  (column: "parked" | "fulfilled", kind: string) => async (a: Queued, ev: LogEvent, db: Queryable) => {
    const r = await db.query(
      `SELECT id FROM basejump_transfers WHERE pending_id = $1 AND ${column} IS NULL LIMIT 1`,
      [pendingKey(ev, a.id)],
    );
    return r.rows[0]?.id ?? orphan(ev, kind);
  };

/** The fields every queue-id event carries, plus its own ref column. */
const queuedPatch = (column: "parked" | "fulfilled") => (a: Queued, ev: LogEvent) => ({
  dest_chain: ev.chain,
  dest_asset: a.destAsset.toLowerCase(),
  source_asset: a.sourceAsset.toLowerCase(),
  recipient: normalizeRecipient(a.recipient),
  net_amount: a.amount.toString(),
  pending_id: pendingKey(ev, a.id),
  [column]: ev.ref,
});

/**
 * Basejump transfers: the fast path out of the landing pool, correlated back to the source that
 * paid for it.
 *
 * The lifecycle branches — a payout either clears the pool straight away or waits on a shortfall —
 * so `completed` and `queued` are alternatives at the same rank. A queued payout is either paid
 * (`fulfilled`) or parked first (`parked`: `parkPending` moved it off the head because its dispatch
 * failed), and a parked one is paid later by `fulfillParked`, which also lands in `fulfilled`. So
 * `parked` outranks `queued`, and `fulfilled` outranks both: a row reads parked until it is paid,
 * whichever order the events are read in. The settlement leg riding NTT beside all of this is
 * `ntt_transfers`, joined rather than duplicated.
 */
export const basejump: Flow = {
  name: "basejump",
  table: "basejump_transfers",
  key: { column: "id", type: "TEXT" },
  states: { initiated: 0, completed: 1, queued: 1, parked: 2, fulfilled: 3 },
  requires: { completed: "initiated", queued: "initiated", parked: "queued", fulfilled: "queued" },
  columns: {
    source_chain: "TEXT",
    source_asset: "TEXT",
    dest_chain: "TEXT",
    dest_asset: "TEXT",
    sender: "TEXT",
    recipient: "TEXT",
    gross_amount: "NUMERIC",
    fee: "NUMERIC",
    net_amount: "NUMERIC",
    /** The NTT manager's sequence for the settlement replenishing the pool. */
    transfer_sequence: "BIGINT",
    message_sequence: "BIGINT",
    pending_id: "TEXT",
    initiated: "JSONB",
    completed: "JSONB",
    queued: "JSONB",
    /** `TransferParked`: the payout left the queue head unpaid and waits for `fulfillParked`. */
    parked: "JSONB",
    /** `PendingTransferFulfilled`, or `ParkedTransferFulfilled` for a parked payout. */
    fulfilled: "JSONB",
  },
  indexes: [
    `CREATE INDEX IF NOT EXISTS idx_basejump_transfers_correlation ON basejump_transfers (source_asset, recipient, net_amount);`,
    `CREATE INDEX IF NOT EXISTS idx_basejump_transfers_recipient ON basejump_transfers (recipient);`,
    `CREATE INDEX IF NOT EXISTS idx_basejump_transfers_sender ON basejump_transfers (sender);`,
    `CREATE INDEX IF NOT EXISTS idx_basejump_transfers_pending ON basejump_transfers (pending_id) WHERE pending_id IS NOT NULL;`,
    `CREATE INDEX IF NOT EXISTS idx_basejump_transfers_initiated ON basejump_transfers (((initiated->>'blockTimestamp')::numeric) DESC);`,
  ],
  legs: [
    {
      role: "basejump-source",
      abi: BridgeInitiatedEvt,
      state: "initiated",
      key: (a: Initiated, ev: LogEvent, db: Queryable) =>
        adoptOrphan(
          db,
          `init-${ev.chain}-${a.transferSequence}`,
          a.asset,
          normalizeRecipient(a.recipient),
          (a.amount - a.fee).toString(),
        ),
      patch: (a: Initiated, ev: LogEvent) => ({
        source_chain: ev.chain,
        source_asset: a.asset.toLowerCase(),
        sender: ev.sender,
        recipient: normalizeRecipient(a.recipient),
        gross_amount: a.amount.toString(),
        fee: a.fee.toString(),
        net_amount: (a.amount - a.fee).toString(),
        transfer_sequence: a.transferSequence.toString(),
        message_sequence: a.messageSequence.toString(),
        initiated: ev.ref,
      }),
    },
    {
      role: "basejump-landing",
      abi: TransferExecutedEvt,
      state: "completed",
      key: (a: Delivery, ev: LogEvent, db: Queryable) =>
        findInitiated(db, a.sourceAsset, normalizeRecipient(a.recipient), a.amount.toString()).then(
          (id) => id ?? orphan(ev, "exec"),
        ),
      patch: (a: Delivery, ev: LogEvent) => ({
        dest_chain: ev.chain,
        dest_asset: a.destAsset.toLowerCase(),
        source_asset: a.sourceAsset.toLowerCase(),
        recipient: normalizeRecipient(a.recipient),
        net_amount: a.amount.toString(),
        completed: ev.ref,
      }),
    },
    {
      role: "basejump-landing",
      abi: TransferQueuedEvt,
      state: "queued",
      key: (a: Queued, ev: LogEvent, db: Queryable) =>
        findInitiated(db, a.sourceAsset, normalizeRecipient(a.recipient), a.amount.toString()).then(
          (id) => id ?? orphan(ev, "queue"),
        ),
      patch: (a: Queued, ev: LogEvent) => ({
        dest_chain: ev.chain,
        dest_asset: a.destAsset.toLowerCase(),
        source_asset: a.sourceAsset.toLowerCase(),
        recipient: normalizeRecipient(a.recipient),
        net_amount: a.amount.toString(),
        pending_id: pendingKey(ev, a.id),
        queued: ev.ref,
      }),
    },
    {
      role: "basejump-landing",
      abi: PendingTransferFulfilledEvt,
      state: "fulfilled",
      key: byPendingId("fulfilled", "fulfill"),
      patch: queuedPatch("fulfilled"),
    },
    {
      role: "basejump-landing",
      abi: TransferParkedEvt,
      state: "parked",
      key: byPendingId("parked", "park"),
      patch: queuedPatch("parked"),
    },
    {
      role: "basejump-landing",
      abi: ParkedTransferFulfilledEvt,
      state: "fulfilled",
      key: byPendingId("fulfilled", "parked-fulfill"),
      patch: queuedPatch("fulfilled"),
    },
  ],
};
