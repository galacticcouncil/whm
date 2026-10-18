import type { Flow, LogEvent, Queryable } from "../../types";
import { normalizeRecipient } from "../../utils";

import {
  BridgeInitiatedEvt,
  PendingTransferFulfilledEvt,
  TransferExecutedEvt,
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
 * A delivery that matched nothing. Kept rather than dropped — a payout with no source is worth
 * seeing — but it has no `initiated`, so the orphan rule keeps it out of the list.
 */
const orphan = (ev: LogEvent, kind: string) =>
  `orphan-${kind}-${ev.chain}-${ev.ref.txHash}-${ev.ref.logIndex}`;

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
    `SELECT id FROM transfers
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
 * Basejump transfers: the fast path out of the landing pool, correlated back to the source that
 * paid for it.
 *
 * The lifecycle branches — a payout either clears the pool straight away or waits on a shortfall —
 * so `completed` and `queued` are alternatives at the same rank, and only `fulfilled` outranks
 * them. The settlement leg riding NTT beside all of this is `ntt_transfers`, joined rather than
 * duplicated.
 */
export const transfers: Flow = {
  name: "transfers",
  table: "transfers",
  key: { column: "id", type: "TEXT" },
  states: { initiated: 0, completed: 1, queued: 1, fulfilled: 2 },
  requires: { completed: "initiated", queued: "initiated", fulfilled: "queued" },
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
    fulfilled: "JSONB",
  },
  indexes: [
    `CREATE INDEX IF NOT EXISTS idx_transfers_correlation ON transfers (source_asset, recipient, net_amount);`,
    `CREATE INDEX IF NOT EXISTS idx_transfers_recipient ON transfers (recipient);`,
    `CREATE INDEX IF NOT EXISTS idx_transfers_sender ON transfers (sender);`,
    `CREATE INDEX IF NOT EXISTS idx_transfers_pending ON transfers (pending_id) WHERE pending_id IS NOT NULL;`,
    `CREATE INDEX IF NOT EXISTS idx_transfers_initiated ON transfers (((initiated->>'blockTimestamp')::numeric) DESC);`,
  ],
  legs: [
    {
      role: "basejump-source",
      abi: BridgeInitiatedEvt,
      state: "initiated",
      key: (a: Initiated, ev: LogEvent) => `init-${ev.chain}-${a.transferSequence}`,
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
        findInitiated(
          db,
          a.sourceAsset,
          normalizeRecipient(a.recipient),
          a.amount.toString(),
        ).then((id) => id ?? orphan(ev, "exec")),
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
        findInitiated(
          db,
          a.sourceAsset,
          normalizeRecipient(a.recipient),
          a.amount.toString(),
        ).then((id) => id ?? orphan(ev, "queue")),
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
      // The queue id is exact, so this one leg needs no heuristic — it finds the row the queued
      // leg already tagged.
      role: "basejump-landing",
      abi: PendingTransferFulfilledEvt,
      state: "fulfilled",
      key: async (a: Queued, ev: LogEvent, db: Queryable) => {
        const r = await db.query(
          `SELECT id FROM transfers WHERE pending_id = $1 AND fulfilled IS NULL LIMIT 1`,
          [pendingKey(ev, a.id)],
        );
        return r.rows[0]?.id ?? orphan(ev, "fulfill");
      },
      patch: (a: Queued, ev: LogEvent) => ({
        dest_chain: ev.chain,
        dest_asset: a.destAsset.toLowerCase(),
        source_asset: a.sourceAsset.toLowerCase(),
        recipient: normalizeRecipient(a.recipient),
        net_amount: a.amount.toString(),
        pending_id: pendingKey(ev, a.id),
        fulfilled: ev.ref,
      }),
    },
  ],
};
