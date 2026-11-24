import { payments as blockchairPayments } from "../../chains/zcash";
import { pool } from "../../db";
import { broadcast, reconcile } from "../../flow";
import log from "../../logger";

import { payouts } from "./flows";

/** Blockchair's Bitcoin API — the same shape as its Zcash one. */
const BLOCKCHAIR_BITCOIN = "https://api.blockchair.com/bitcoin";

/** How often deliveries still without their destination-chain transaction are looked up. */
const POLL_MS = 60_000;

/** A payout lands after the router signs it; allow the clocks this much disagreement. */
const CLOCK_SKEW_MS = 60_000;

/** One payment into a recipient on its own chain. */
interface Payment {
  hash: string;
  /** Unix ms. */
  at: number;
  /** In the asset's smallest units there. */
  amount: bigint;
}

/** How a destination's deliveries are found where they land. */
interface Destination {
  /** Recipients an explorer can see payments into — a shielded one cannot be paired. */
  visible: (address: string) => boolean;
  /** An address's incoming payments, oldest first. */
  payments: (address: string) => Promise<Payment[]>;
}

/** Each destination whose withdrawals are paired with their transaction, by intents ledger id. */
const DESTINATIONS: Record<string, Destination> = {
  "nep141:zec.omft.near": { visible: (a) => a.startsWith("t"), payments: (a) => blockchairPayments(a) },
  "nep141:nbtc.bridge.near": { visible: () => true, payments: (a) => blockchairPayments(a, BLOCKCHAIR_BITCOIN) },
};

type Pending = { id: string; amount: string; signed_at: string };

/**
 * Where a withdrawal landed. The router's delivery is a bridge withdrawal signed on NEAR; the bridge
 * then pays on the asset's own chain, and nothing on NEAR names that transaction. So it is read from
 * the recipient's own history: the first payment into the address after the delivery was signed,
 * for no more than was withdrawn (the bridge's fee comes off the way). Deliveries to one address are
 * paired with its payments in order, each payment used once.
 */
export class PayoutPoller {
  private timer?: NodeJS.Timeout;
  private busy = false;

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    log.info(`[intents-v2] payout poller: every ${POLL_MS}ms`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // The recipient and asset are the terms', read from any order of them.
      const pending = await pool.query(
        `SELECT p.id, t.destination_asset AS asset, t.recipient AS receiver, p.amount,
                (p.signed->>'blockTimestamp')::bigint AS signed_at
           FROM intent_v2_payouts p
           JOIN LATERAL (SELECT recipient, destination_asset, recipient_kind FROM intent_v2_orders o
                          WHERE o.auth_path = p.auth_path LIMIT 1) t ON true
          WHERE p.state = 'delivered' AND p.dest_tx IS NULL
            AND t.destination_asset = ANY($1) AND t.recipient_kind = 0
          ORDER BY signed_at`,
        [Object.keys(DESTINATIONS)],
      );
      const byReceiver = new Map<string, { dest: Destination; receiver: string; rows: Pending[] }>();
      for (const r of pending.rows) {
        const dest = DESTINATIONS[r.asset]!;
        if (!dest.visible(r.receiver)) continue;
        const k = `${r.asset} ${r.receiver}`;
        const group = byReceiver.get(k) ?? { dest, receiver: r.receiver, rows: [] as Pending[] };
        group.rows.push(r);
        byReceiver.set(k, group);
      }
      for (const { dest, receiver, rows } of byReceiver.values()) await this.pair(dest, receiver, rows);
    } catch (e) {
      log.error(`[intents-v2] payout tick: ${(e as Error).stack ?? String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Pair one address's unpaired deliveries with its payments.
   *
   * @param dest Where the asset lands.
   * @param receiver The address there.
   * @param rows Its deliveries still without a transaction, oldest first.
   */
  private async pair(dest: Destination, receiver: string, rows: Pending[]): Promise<void> {
    // Payments already paired with an earlier delivery to this address, under any terms.
    const used = new Set(
      (
        await pool.query(
          `SELECT DISTINCT p.dest_tx FROM intent_v2_payouts p
             JOIN intent_v2_orders o ON o.auth_path = p.auth_path
            WHERE o.recipient = $1 AND p.dest_tx IS NOT NULL`,
          [receiver],
        )
      ).rows.map((r) => r.dest_tx as string),
    );
    const incoming = (await dest.payments(receiver)).filter((t) => !used.has(t.hash));

    for (const row of rows) {
      const i = incoming.findIndex(
        (t) => t.at >= Number(row.signed_at) - CLOCK_SKEW_MS && t.amount <= BigInt(row.amount),
      );
      if (i < 0) continue;
      const [t] = incoming.splice(i, 1);
      const applied = await reconcile(pool, payouts, payouts.key.column, row.id, "delivered", {
        dest_tx: t!.hash,
        dest_amount: t!.amount.toString(),
        dest_at: t!.at,
      });
      if (applied) {
        broadcast({ flow: payouts.name, kind: "updated", record: applied.row, previousState: applied.previousState });
      }
    }
  }
}
