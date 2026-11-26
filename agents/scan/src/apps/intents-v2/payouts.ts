import { accountWithdrawals } from "../../chains/near/omni";
import type { FastNear } from "../../chains/near/fastnear";
import { pool } from "../../db";
import { broadcast, reconcile } from "../../flow";
import log from "../../logger";

import { payouts } from "./flows";
import { landing, type Pending } from "./landing";

/** How often deliveries not yet confirmed on their own chain are followed. */
const POLL_MS = 20_000;

/** Omni's connectors on NEAR, one per UTXO route the router withdraws through. */
const CONNECTORS = new Set(["zcash-connector.bridge.near", "btc-connector.bridge.near"]);

/**
 * Where a withdrawal landed, read on NEAR alone. The router's delivery puts the coin on `A_utxo`; the
 * UTXO relayer withdraws it through Omni's connector, which names the coin's transaction and what it
 * pays the moment it is submitted, and later verifies its inclusion on the coin's chain. Both name
 * `A_utxo`, so its history in FastNEAR's index holds them.
 */
export class PayoutPoller {
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly api: FastNear) {}

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
      const pending = await pool.query<Pending & { utxo_account: string }>(
        `SELECT id, utxo_account, dest_tx, (signed->>'blockTimestamp')::bigint AS signed_at
           FROM intent_v2_payouts
          WHERE state = 'delivered' AND utxo_account IS NOT NULL AND dest_at IS NULL
          ORDER BY signed_at`,
      );
      const byAccount = new Map<string, Pending[]>();
      for (const r of pending.rows) byAccount.set(r.utxo_account, [...(byAccount.get(r.utxo_account) ?? []), r]);
      for (const [account, rows] of byAccount) await this.follow(account, rows);
    } catch (e) {
      log.error(`[intents-v2] payout tick: ${(e as Error).stack ?? String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Follow one `A_utxo`'s pending deliveries to their withdrawal and its verification.
   *
   * @param account `A_utxo`.
   * @param rows Its deliveries not yet confirmed, oldest first.
   */
  private async follow(account: string, rows: Pending[]): Promise<void> {
    const { withdrawals, verifications } = await accountWithdrawals(this.api, account, CONNECTORS);
    for (const row of rows) {
      const patch = landing(row, withdrawals, verifications);
      if (!patch) continue;
      const applied = await reconcile(pool, payouts, payouts.key.column, row.id, "delivered", patch);
      if (applied) {
        broadcast({ flow: payouts.name, kind: "updated", record: applied.row, previousState: applied.previousState });
      }
    }
  }
}
