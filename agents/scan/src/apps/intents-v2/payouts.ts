import { BLOCKCHAIR } from "../../chains/zcash/consts";
import { pool } from "../../db";
import { broadcast, reconcile } from "../../flow";
import log from "../../logger";

import { payouts } from "./flows";

/** How often deliveries still without their Zcash transaction are looked up. */
const POLL_MS = 60_000;

/** A payout lands after the router signs it; allow the clocks this much disagreement. */
const CLOCK_SKEW_MS = 60_000;

const ZEC = "nep141:zec.omft.near";

/** One transaction in an address's Blockchair history. */
interface Movement {
  hash: string;
  time: string;
  /** Zatoshi into the address; negative for a spend. */
  balance_change: number;
}

/**
 * Where a ZEC delivery landed. The router's delivery is a POA withdrawal signed on NEAR; POA then pays
 * on Zcash, and nothing on NEAR names that transaction. So it is read from the recipient's own
 * history: the first payment into the address after the delivery was signed, for no more than was
 * withdrawn (POA's fee comes off the way). Deliveries to one address are paired with its payments in
 * order, each payment used once.
 *
 * Transparent addresses only — a shielded payment is invisible to an explorer, and stays unpaired.
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
        `SELECT p.id, t.recipient AS receiver, p.amount, (p.signed->>'blockTimestamp')::bigint AS signed_at
           FROM intent_v2_payouts p
           JOIN LATERAL (SELECT recipient, destination_asset, recipient_kind FROM intent_v2_orders o
                          WHERE o.auth_path = p.auth_path LIMIT 1) t ON true
          WHERE p.state = 'delivered' AND p.dest_tx IS NULL
            AND t.destination_asset = $1 AND t.recipient_kind = 0 AND t.recipient LIKE 't%'
          ORDER BY signed_at`,
        [ZEC],
      );
      const byReceiver = new Map<string, { id: string; amount: string; signed_at: string }[]>();
      for (const r of pending.rows) byReceiver.set(r.receiver, [...(byReceiver.get(r.receiver) ?? []), r]);
      for (const [receiver, rows] of byReceiver) await this.pair(receiver, rows);
    } catch (e) {
      log.error(`[intents-v2] payout tick: ${(e as Error).stack ?? String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Pair one address's unpaired deliveries with its payments.
   *
   * @param receiver The Zcash address.
   * @param rows Its deliveries still without a transaction, oldest first.
   */
  private async pair(receiver: string, rows: { id: string; amount: string; signed_at: string }[]): Promise<void> {
    const res = await fetch(
      `${BLOCKCHAIR}/dashboards/address/${receiver}?transaction_details=true&limit=100`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!res.ok) throw new Error(`blockchair ${receiver}: ${res.status}`);
    const body = (await res.json()) as { data?: Record<string, { transactions?: Movement[] }> };
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
    const incoming = (body.data?.[receiver]?.transactions ?? [])
      .filter((t) => t.balance_change > 0 && !used.has(t.hash))
      .map((t) => ({ ...t, at: Date.parse(`${t.time.replace(" ", "T")}Z`) }))
      .sort((a, b) => a.at - b.at);

    for (const row of rows) {
      const i = incoming.findIndex(
        (t) => t.at >= Number(row.signed_at) - CLOCK_SKEW_MS && BigInt(t.balance_change) <= BigInt(row.amount),
      );
      if (i < 0) continue;
      const [t] = incoming.splice(i, 1);
      const applied = await reconcile(pool, payouts, payouts.key.column, row.id, "delivered", {
        dest_tx: t!.hash,
        dest_amount: String(t!.balance_change),
        dest_at: t!.at,
      });
      if (applied) {
        broadcast({ flow: payouts.name, kind: "updated", record: applied.row, previousState: applied.previousState });
      }
    }
  }
}
