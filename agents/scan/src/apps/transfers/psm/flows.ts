import { PSM } from "../../../deployments";
import { rankFn } from "../../../flow/schema";
import type { Flow, LogEvent, Queryable } from "../../../types";
import { bytes32ToAddress } from "../../../utils";

import {
  ClaimedEvt,
  CreditUnpayableEvt,
  DepositedEvt,
  DisputedEvt,
  MintedEvt,
  MintQueuedEvt,
  PendingMintCancelledEvt,
  PendingMintFlushedEvt,
  RedeemCreditedEvt,
  RedeemInitiatedEvt,
  RedeemReturnedEvt,
  RedemptionCancelledEvt,
} from "./abi";

interface Deposited {
  from: `0x${string}`;
  recipient: `0x${string}`;
  amount: bigint;
  sequence: bigint;
}

interface RedeemInitiated {
  from: `0x${string}`;
  baseRecipient: `0x${string}`;
  usdcAmount: bigint;
  sequence: bigint;
}

interface Mint {
  recipient: `0x${string}`;
  usdcAmount: bigint;
}

type Minted = Mint & { hollarAmount: bigint };
type PendingMint = Mint & { id: bigint };
type PendingMintCancelled = PendingMint & { baseRecipient: `0x${string}`; kind: number };

interface Credited {
  index: bigint;
  recipient: `0x${string}`;
  gross: bigint;
  fee: bigint;
  credited: bigint;
  kind: number;
}

interface Payout {
  recipient: `0x${string}`;
  amount: bigint;
}

type Returned = Payout & { origin: `0x${string}` };

interface Cancelled {
  index: bigint;
  gross: bigint;
  hydrationRecipient: `0x${string}`;
}

/** `PsmPayload.KIND_REFUND`: a credit that is a cancelled mint's USDC coming home. */
const KIND_REFUND = 3;

/**
 * How far before its origin a delivery may be stamped and still be that origin's. The two chains'
 * block clocks differ by seconds; anything older is some other transfer's leftover.
 */
const CLOCK_SKEW_MS = 10 * 60_000;

/** The corridor a vault or a facilitator belongs to, named by the vault's chain. */
const CORRIDORS = new Map<string, string>(
  Object.entries(PSM).flatMap(([chain, c]) => [
    [c.vault.toLowerCase(), chain],
    [c.facilitator.toLowerCase(), chain],
  ]),
);
const corridor = (ev: LogEvent) => CORRIDORS.get(ev.address.toLowerCase()) ?? ev.chain;

/**
 * A queue slot, namespaced by the contract that numbers it: the facilitator's pending mints and the
 * vault's credits each run a counter of their own, per corridor.
 */
const slot = (ev: LogEvent, id: bigint) => `${ev.address.toLowerCase()}:${id}`;

/**
 * A delivery that matched nothing. Kept rather than dropped — its origin may be on the other chain
 * and not read yet, and adopts it when it is — but it has no `initiated`, so it stays out of lists.
 */
const orphan = (ev: LogEvent, kind: string) =>
  `orphan-${kind}-${ev.chain}-${ev.ref.txHash}-${ev.ref.logIndex}`;

const first = async (db: Queryable, sql: string, values: unknown[]): Promise<string | null> =>
  (await db.query(sql, values)).rows[0]?.id ?? null;

/** The column naming who an orphan delivery was for. */
type Party = "mint_recipient" | "credit_recipient";

/** When an orphan's delivery was stamped. */
const ORPHAN_AT = `(COALESCE(minted, mint_queued, credited, returned, disputed)->>'blockTimestamp')::numeric`;

/**
 * The oldest orphan still waiting: of the given kinds, for this party and amount, and not stamped
 * long before the event taking it.
 *
 * @param n The first of its four parameters, which `waitingArgs` supplies in order.
 */
const waiting = (party: Party, n: number) =>
  `SELECT id FROM psm_transfers
    WHERE id LIKE ANY($${n}) AND initiated IS NULL
      AND lower(${party}) = lower($${n + 1}) AND amount = $${n + 2}::numeric
      AND ${ORPHAN_AT} >= $${n + 3}
    ORDER BY ${ORPHAN_AT}
    LIMIT 1`;

/**
 * @param kinds The orphan kinds that can be taken.
 * @param who The party, as the taking event names them.
 * @param ev The taking event; nothing stamped long before it is its delivery.
 */
const waitingArgs = (kinds: string[], who: string, amount: string, ev: LogEvent): unknown[] => [
  kinds.map((k) => `orphan-${k}-%`),
  who,
  amount,
  ev.ref.blockTimestamp - CLOCK_SKEW_MS,
];

/**
 * An origin's row: its own key, taking over the oldest delivery that arrived ahead of it.
 *
 * Each chain is drained on its own, so a mint can be read before the deposit it answers, and a
 * credit before its redemption. That delivery found no origin and waits as an orphan; renaming it to
 * the origin's key lets the origin's patch merge into it.
 *
 * @param db The drain's transaction.
 * @param id The origin's key.
 * @param kinds The orphan kinds this origin can be answered by.
 * @param party The column naming who the delivery was for.
 * @param who That party, as the origin names it.
 * @param ev The origin's event; nothing stamped long before it is its delivery.
 */
async function adoptOrphan(
  db: Queryable,
  id: string,
  kinds: string[],
  party: Party,
  who: string,
  amount: string,
  ev: LogEvent,
): Promise<string> {
  await db.query(
    `UPDATE psm_transfers SET id = $1
      WHERE id = (${waiting(party, 2)})
        AND NOT EXISTS (SELECT 1 FROM psm_transfers WHERE id = $1)`,
    [id, ...waitingArgs(kinds, who, amount, ev)],
  );
  return id;
}

/**
 * Merge the oldest waiting orphan into a row that already exists.
 *
 * Not every hand-off starts a row: a redemption sent back is minted again on Hydration, and a
 * cancelled mint is credited back on the vault's chain. Read ahead of the event that explains it,
 * that second delivery waits as an orphan — and the row it belongs to has a key of its own, so there
 * is nothing to rename. Its columns move over instead, and the orphan goes.
 *
 * @param db The drain's transaction.
 * @param into The row taking the orphan.
 */
async function absorbOrphan(
  db: Queryable,
  into: string,
  kinds: string[],
  party: Party,
  who: string,
  amount: string,
  ev: LogEvent,
): Promise<void> {
  const taken = await db.query(
    `DELETE FROM psm_transfers WHERE id = (${waiting(party, 1)}) RETURNING *`,
    waitingArgs(kinds, who, amount, ev),
  );
  const o = taken.rows[0];
  if (!o) return;

  const columns = Object.entries(psm.columns);
  const rank = rankFn(psm);
  await db.query(
    `UPDATE psm_transfers SET
       state = CASE WHEN ${rank}($2) > ${rank}(state) THEN $2 ELSE state END,
       ${columns.map(([c, type], i) => `${c} = COALESCE(${c}, $${i + 3}::${type})`).join(", ")},
       updated_at = NOW()
     WHERE id = $1`,
    [into, o.state, ...columns.map(([c]) => o[c])],
  );
}

/**
 * The oldest deposit still waiting on its mint.
 *
 * `Minted` and `MintQueued` name no message, so a deposit and what answers it share only the
 * recipient and the amount. Two alike are told apart by age, which changes nothing a reader sees:
 * both end minted.
 *
 * @param db The drain's transaction.
 * @param queued Whether a deposit already queued still counts — it does for the mint that flushes it.
 */
const findDeposit = (db: Queryable, recipient: string, amount: string, queued: boolean) =>
  first(
    db,
    `SELECT id FROM psm_transfers
      WHERE direction = 'deposit' AND initiated IS NOT NULL
        AND lower(recipient) = lower($1) AND amount = $2::numeric
        AND minted IS NULL AND mint_cancelled IS NULL
        ${queued ? "" : "AND mint_queued IS NULL"}
      ORDER BY (initiated->>'blockTimestamp')::numeric, sequence
      LIMIT 1`,
    [recipient, amount],
  );

/**
 * The oldest redemption sent back and still waiting on its HOLLAR: returned for its fee limit, or
 * cancelled out of the payout queue. Either way the re-mint goes to who redeemed.
 */
const findSentBack = (db: Queryable, origin: string, amount: string, queued: boolean) =>
  first(
    db,
    `SELECT id FROM psm_transfers
      WHERE direction = 'redeem' AND (returned IS NOT NULL OR cancelled IS NOT NULL)
        AND lower(sender) = lower($1) AND amount = $2::numeric
        AND minted IS NULL
        ${queued ? "" : "AND mint_queued IS NULL"}
      ORDER BY (COALESCE(returned, cancelled)->>'blockTimestamp')::numeric
      LIMIT 1`,
    [origin, amount],
  );

/** A queued mint whose origin is not read yet: where the mint flushing it belongs. */
const findOrphanQueue = (db: Queryable, recipient: string, amount: string) =>
  first(
    db,
    `SELECT id FROM psm_transfers
      WHERE id LIKE 'orphan-queue-%' AND initiated IS NULL
        AND lower(mint_recipient) = lower($1) AND amount = $2::numeric
        AND minted IS NULL
      ORDER BY (mint_queued->>'blockTimestamp')::numeric
      LIMIT 1`,
    [recipient, amount],
  );

/**
 * The oldest redemption the vault has not answered yet. A credit names its queue slot but not the
 * message it came by, so it is matched like a mint: by who is paid and how much.
 *
 * @param origin Who redeemed, where the vault's event says.
 */
const findRedeem = (db: Queryable, recipient: string, amount: string, origin?: string) =>
  first(
    db,
    `SELECT id FROM psm_transfers
      WHERE direction = 'redeem' AND initiated IS NOT NULL
        AND lower(recipient) = lower($1) AND amount = $2::numeric
        AND ($3::text IS NULL OR lower(sender) = lower($3))
        AND credited IS NULL AND returned IS NULL AND disputed IS NULL
      ORDER BY (initiated->>'blockTimestamp')::numeric, sequence
      LIMIT 1`,
    [recipient, amount, origin ?? null],
  );

/** The oldest cancelled mint whose USDC has not been credited back yet. */
const findRefund = (db: Queryable, recipient: string, amount: string) =>
  first(
    db,
    `SELECT id FROM psm_transfers
      WHERE direction = 'deposit' AND mint_cancelled IS NOT NULL
        AND lower(refund_recipient) = lower($1) AND amount = $2::numeric
        AND credited IS NULL
      ORDER BY (mint_cancelled->>'blockTimestamp')::numeric
      LIMIT 1`,
    [recipient, amount],
  );

/**
 * The credit a payment settles: the vault's lowest slot still queued. The queue pays strictly head
 * first, so with every credit stored that is exact; the recipient and the amount only guard a gap.
 */
const findHead = (db: Queryable, ev: LogEvent, recipient: string, amount: string) =>
  first(
    db,
    `SELECT id FROM psm_transfers
      WHERE queue_id LIKE $1 AND credited IS NOT NULL
        AND claimed IS NULL AND unpayable IS NULL AND cancelled IS NULL
        AND lower(credit_recipient) = lower($2) AND net_amount = $3::numeric
      ORDER BY queue_index
      LIMIT 1`,
    [`${ev.address.toLowerCase()}:%`, recipient, amount],
  );

/**
 * The HOLLAR PSM: USDC locked in a vault for HOLLAR minted on Hydration, and HOLLAR burned for USDC
 * paid out of the vault's queue.
 *
 * One table holds both directions, each row starting at its own `initiated`: a deposit's `Deposited`
 * or a redemption's `RedeemInitiated`. Only those two events carry the message's sequence, so they
 * key the row; every delivery is matched to its origin by who it is for and how much, and the legs
 * that follow a queue entry by that entry's slot. A delivery read ahead of what explains it waits as
 * an orphan: an origin renames it to its own key, a later hand-off merges it into the row it found.
 *
 * A deposit is minted, or queued and then flushed or cancelled — and a cancelled one's USDC comes
 * back through the vault's queue like a redemption. A redemption is credited and then paid, retired
 * unpaid or cancelled; or sent back before it is booked. Ranks only keep `state` from regressing —
 * what a row means is read off its refs, in `../db.ts`.
 */
export const psm: Flow = {
  name: "psm",
  table: "psm_transfers",
  key: { column: "id", type: "TEXT" },
  unique: ["pending_id", "queue_id"],
  states: {
    initiated: 0,
    queued: 1,
    minted: 2,
    flushed: 2,
    mint_cancelled: 2,
    credited: 3,
    returned: 3,
    disputed: 3,
    claimed: 4,
    unpayable: 4,
    cancelled: 4,
  },
  requires: {
    minted: "initiated",
    mint_queued: "initiated",
    flushed: "mint_queued",
    mint_cancelled: "mint_queued",
    credited: "initiated",
    returned: "initiated",
    disputed: "initiated",
    claimed: "credited",
    unpayable: "credited",
    cancelled: "credited",
  },
  columns: {
    /** `deposit` or `redeem`. */
    direction: "TEXT",
    /** The vault's chain. */
    corridor: "TEXT",
    sender: "TEXT",
    recipient: "TEXT",
    /** USDC units, whichever way it goes: what was deposited, or the HOLLAR burned at par. */
    amount: "NUMERIC",
    /** A redemption's fee, taken when the vault books it. */
    fee: "NUMERIC",
    /** What the vault owes for it: `amount` less `fee`. */
    net_amount: "NUMERIC",
    hollar_amount: "NUMERIC",
    /** The origin message's Wormhole sequence, per emitter. */
    sequence: "BIGINT",
    /** Who a mint was for, as the facilitator names them — what an orphan mint is adopted by. */
    mint_recipient: "TEXT",
    /** The facilitator's queued mint. */
    pending_id: "TEXT",
    /** Where a cancelled mint's USDC goes back to. */
    refund_recipient: "TEXT",
    /** Who the vault pays, as it names them — what an orphan credit is adopted by. */
    credit_recipient: "TEXT",
    /** The vault's queued credit. */
    queue_id: "TEXT",
    queue_index: "NUMERIC",
    initiated: "JSONB",
    minted: "JSONB",
    mint_queued: "JSONB",
    flushed: "JSONB",
    mint_cancelled: "JSONB",
    credited: "JSONB",
    claimed: "JSONB",
    unpayable: "JSONB",
    cancelled: "JSONB",
    returned: "JSONB",
    disputed: "JSONB",
  },
  indexes: [
    `CREATE INDEX IF NOT EXISTS idx_psm_transfers_origin ON psm_transfers (direction, recipient, amount);`,
    `CREATE INDEX IF NOT EXISTS idx_psm_transfers_recipient ON psm_transfers (recipient);`,
    `CREATE INDEX IF NOT EXISTS idx_psm_transfers_sender ON psm_transfers (sender);`,
    `CREATE INDEX IF NOT EXISTS idx_psm_transfers_queue ON psm_transfers (queue_index) WHERE queue_id IS NOT NULL;`,
    `CREATE INDEX IF NOT EXISTS idx_psm_transfers_initiated ON psm_transfers (((initiated->>'blockTimestamp')::numeric) DESC);`,
  ],
  legs: [
    // ─── Deposit: the vault's chain to Hydration ───
    {
      role: "psm-vault",
      abi: DepositedEvt,
      state: "initiated",
      key: (a: Deposited, ev: LogEvent, db: Queryable) =>
        adoptOrphan(
          db,
          `deposit-${corridor(ev)}-${a.sequence}`,
          ["mint", "queue"],
          "mint_recipient",
          bytes32ToAddress(a.recipient),
          a.amount.toString(),
          ev,
        ),
      patch: (a: Deposited, ev: LogEvent) => ({
        direction: "deposit",
        corridor: corridor(ev),
        sender: a.from.toLowerCase(),
        recipient: bytes32ToAddress(a.recipient),
        amount: a.amount.toString(),
        sequence: a.sequence.toString(),
        initiated: ev.ref,
      }),
    },
    {
      // Also what flushes a queued mint and what hands a sent-back redemption its HOLLAR, hence the
      // order: a deposit first, queued ones included, then a redemption waiting on a re-mint.
      role: "psm-facilitator",
      abi: MintedEvt,
      state: "minted",
      key: async (a: Minted, ev: LogEvent, db: Queryable) => {
        const amount = a.usdcAmount.toString();
        return (
          (await findDeposit(db, a.recipient, amount, true)) ??
          (await findSentBack(db, a.recipient, amount, true)) ??
          (await findOrphanQueue(db, a.recipient, amount)) ??
          orphan(ev, "mint")
        );
      },
      patch: (a: Minted, ev: LogEvent) => ({
        mint_recipient: a.recipient.toLowerCase(),
        amount: a.usdcAmount.toString(),
        hollar_amount: a.hollarAmount.toString(),
        minted: ev.ref,
      }),
    },
    {
      role: "psm-facilitator",
      abi: MintQueuedEvt,
      state: "queued",
      key: async (a: PendingMint, ev: LogEvent, db: Queryable) => {
        const amount = a.usdcAmount.toString();
        return (
          (await findDeposit(db, a.recipient, amount, false)) ??
          (await findSentBack(db, a.recipient, amount, false)) ??
          orphan(ev, "queue")
        );
      },
      patch: (a: PendingMint, ev: LogEvent) => ({
        mint_recipient: a.recipient.toLowerCase(),
        amount: a.usdcAmount.toString(),
        pending_id: slot(ev, a.id),
        mint_queued: ev.ref,
      }),
    },
    {
      // The queue id is exact, so the legs after `MintQueued` need no matching.
      role: "psm-facilitator",
      abi: PendingMintFlushedEvt,
      state: "flushed",
      keyBy: "pending_id",
      key: (a: PendingMint, ev: LogEvent) => slot(ev, a.id),
      patch: (_a: PendingMint, ev: LogEvent) => ({ flushed: ev.ref }),
    },
    {
      role: "psm-facilitator",
      abi: PendingMintCancelledEvt,
      state: "mint_cancelled",
      keyBy: "pending_id",
      key: async (a: PendingMintCancelled, ev: LogEvent, db: Queryable) => {
        const pending = slot(ev, a.id);
        // The refund's credit may have been read first, on the vault's chain.
        if (Number(a.kind) === KIND_REFUND) {
          const id = await first(db, `SELECT id FROM psm_transfers WHERE pending_id = $1`, [pending]);
          if (id) {
            await absorbOrphan(
              db,
              id,
              ["refund"],
              "credit_recipient",
              bytes32ToAddress(a.baseRecipient),
              a.usdcAmount.toString(),
              ev,
            );
          }
        }
        return pending;
      },
      patch: (a: PendingMintCancelled, ev: LogEvent) => ({
        refund_recipient: bytes32ToAddress(a.baseRecipient),
        mint_cancelled: ev.ref,
      }),
    },

    // ─── Redeem: Hydration to the vault's chain ───
    {
      role: "psm-facilitator",
      abi: RedeemInitiatedEvt,
      state: "initiated",
      key: (a: RedeemInitiated, ev: LogEvent, db: Queryable) =>
        adoptOrphan(
          db,
          `redeem-${corridor(ev)}-${a.sequence}`,
          ["credit", "return", "dispute"],
          "credit_recipient",
          a.baseRecipient,
          a.usdcAmount.toString(),
          ev,
        ),
      patch: (a: RedeemInitiated, ev: LogEvent) => ({
        direction: "redeem",
        corridor: corridor(ev),
        sender: a.from.toLowerCase(),
        recipient: a.baseRecipient.toLowerCase(),
        amount: a.usdcAmount.toString(),
        sequence: a.sequence.toString(),
        initiated: ev.ref,
      }),
    },
    {
      // Every credit is stored, matched or not: a payment settles the lowest slot still queued, so
      // one credit missing would hand its payment to the next.
      role: "psm-vault",
      abi: RedeemCreditedEvt,
      state: "credited",
      key: async (a: Credited, ev: LogEvent, db: Queryable) => {
        // An unmatched refund waits under a kind of its own: a redemption must never adopt it.
        const refund = Number(a.kind) === KIND_REFUND;
        const find = refund ? findRefund : findRedeem;
        return (
          (await find(db, a.recipient, a.gross.toString())) ?? orphan(ev, refund ? "refund" : "credit")
        );
      },
      patch: (a: Credited, ev: LogEvent) => ({
        credit_recipient: a.recipient.toLowerCase(),
        amount: a.gross.toString(),
        fee: a.fee.toString(),
        net_amount: a.credited.toString(),
        queue_id: slot(ev, a.index),
        queue_index: a.index.toString(),
        credited: ev.ref,
      }),
    },
    {
      role: "psm-vault",
      abi: ClaimedEvt,
      state: "claimed",
      key: async (a: Payout, ev: LogEvent, db: Queryable) =>
        (await findHead(db, ev, a.recipient, a.amount.toString())) ?? orphan(ev, "claim"),
      patch: (_a: Payout, ev: LogEvent) => ({ claimed: ev.ref }),
    },
    {
      role: "psm-vault",
      abi: CreditUnpayableEvt,
      state: "unpayable",
      keyBy: "queue_id",
      key: (a: Credited, ev: LogEvent) => slot(ev, a.index),
      patch: (_a: Credited, ev: LogEvent) => ({ unpayable: ev.ref }),
    },
    {
      role: "psm-vault",
      abi: RedemptionCancelledEvt,
      state: "cancelled",
      keyBy: "queue_id",
      key: async (a: Cancelled, ev: LogEvent, db: Queryable) => {
        const queue = slot(ev, a.index);
        // The re-mint may have been read first, on Hydration.
        const id = await first(
          db,
          `SELECT id FROM psm_transfers WHERE queue_id = $1 AND direction = 'redeem'`,
          [queue],
        );
        if (id) {
          await absorbOrphan(
            db,
            id,
            ["mint", "queue"],
            "mint_recipient",
            bytes32ToAddress(a.hydrationRecipient),
            a.gross.toString(),
            ev,
          );
        }
        return queue;
      },
      patch: (_a: Cancelled, ev: LogEvent) => ({ cancelled: ev.ref }),
    },
    {
      role: "psm-vault",
      abi: RedeemReturnedEvt,
      state: "returned",
      key: async (a: Returned, ev: LogEvent, db: Queryable) => {
        const amount = a.amount.toString();
        const id = await findRedeem(db, a.recipient, amount, a.origin);
        if (!id) return orphan(ev, "return");
        // The re-mint may have been read first, on Hydration.
        await absorbOrphan(db, id, ["mint", "queue"], "mint_recipient", a.origin, amount, ev);
        return id;
      },
      patch: (a: Returned, ev: LogEvent) => ({
        credit_recipient: a.recipient.toLowerCase(),
        amount: a.amount.toString(),
        returned: ev.ref,
      }),
    },
    {
      role: "psm-vault",
      abi: DisputedEvt,
      state: "disputed",
      key: async (a: Payout, ev: LogEvent, db: Queryable) =>
        (await findRedeem(db, a.recipient, a.amount.toString())) ?? orphan(ev, "dispute"),
      patch: (a: Payout, ev: LogEvent) => ({
        credit_recipient: a.recipient.toLowerCase(),
        amount: a.amount.toString(),
        disputed: ev.ref,
      }),
    },
  ],
};
