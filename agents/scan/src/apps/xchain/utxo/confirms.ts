import { pool } from "../../../db";
import { broadcast, reconcile } from "../../../flow";
import log from "../../../logger";

import { utxo } from "./flows";
import { byChain } from "./routes";

const POLL_MS = 60_000;

/**
 * A withdrawal's last leg: the coin's payout landing in a block on its own chain. That chain is not
 * indexed, so every withdrawal whose payout is known and unconfirmed is asked about, in batches, once
 * a minute — and drops out of the set once it lands.
 */
export class ConfirmPoller {
  private timer?: NodeJS.Timeout;
  private busy = false;

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    log.info(`[xchain] confirm poller: every ${POLL_MS}ms`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await pool.query<{ id: string; chain: string; utxo_tx: string }>(
        `SELECT id, chain, utxo_tx FROM utxo_transfers
          WHERE direction = 'withdraw' AND utxo_tx IS NOT NULL AND confirmed IS NULL`,
      );
      const byRoute = new Map<string, typeof r.rows>();
      for (const row of r.rows) byRoute.set(row.chain, [...(byRoute.get(row.chain) ?? []), row]);

      for (const [chain, rows] of byRoute) {
        const route = byChain(chain);
        if (!route) continue;
        const landed = await route.inclusions([...new Set(rows.map((x) => x.utxo_tx))]);
        for (const row of rows) {
          const at = landed.get(row.utxo_tx);
          if (!at) continue;
          const applied = await reconcile(pool, utxo, utxo.key.column, row.id, "confirmed", {
            confirmed: {
              chain,
              blockNumber: String(at.block),
              blockTimestamp: at.blockTimestamp,
              txHash: row.utxo_tx,
              logIndex: 0,
            },
          });
          if (applied) {
            broadcast({
              flow: utxo.name,
              kind: "updated",
              record: applied.row,
              previousState: applied.previousState,
            });
          }
        }
      }
    } catch (e) {
      log.error(`[xchain] confirm poller: ${(e as Error).stack ?? String(e)}`);
    } finally {
      this.busy = false;
    }
  }
}
