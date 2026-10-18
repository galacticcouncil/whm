import { FastNear, nearLogs } from "../../../chains/near/fastnear";
import { pool } from "../../../db";
import { broadcast, reconcile } from "../../../flow";
import log from "../../../logger";

import { utxo } from "./flows";
import { ROUTES } from "./routes";

const POLL_MS = 20_000;

interface Pending {
  id: string;
  near_account: string;
  /** When NEAR delivered to the account, unix ms. */
  received_at: string;
}

interface Withdrawal {
  ref: {
    chain: string;
    blockNumber: string;
    blockTimestamp: number;
    txHash: string;
    logIndex: number;
  };
  utxoTx: string;
  bridgeFee: string | null;
  minerFee: string | null;
  received: string | null;
}

/**
 * A withdrawal's NEAR leg.
 *
 * After NEAR delivers, the coin sits on the withdrawal's derived account until its withdraw is
 * signed (`utxo_signs`) and anyone relays it — a transaction on that account, which no watched
 * account sees. So for every withdrawal signed and not yet withdrawn, this reads the account's own
 * history for the connector's `generate_btc_pending_info`: the coin's payout transaction, named
 * before Omni has even signed it.
 *
 * A withdraw takes the account's whole balance, so one can cover several deliveries: each pending
 * row takes the first withdraw at or after its delivery.
 */
export class WithdrawPoller {
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly api: FastNear) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    log.info(`[xchain] withdraw poller: every ${POLL_MS}ms`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const r = await pool.query<Pending>(
        `SELECT u.id, u.near_account, n.settled->>'blockTimestamp' AS received_at
           FROM utxo_transfers u JOIN ntt_transfers n ON n.digest = u.digest
          WHERE u.direction = 'withdraw' AND u.withdrawn IS NULL AND n.state = 'redeemed'
            AND EXISTS (SELECT 1 FROM utxo_signs s
                         WHERE s.account = u.near_account AND s.action = 'withdraw'
                           AND (s.signed->>'blockTimestamp')::bigint >= (n.settled->>'blockTimestamp')::bigint)
          ORDER BY received_at`,
      );
      const byAccount = new Map<string, Pending[]>();
      for (const p of r.rows)
        byAccount.set(p.near_account, [...(byAccount.get(p.near_account) ?? []), p]);
      for (const [account, rows] of byAccount) await this.settle(account, rows);
    } catch (e) {
      log.error(`[xchain] withdraw poller: ${(e as Error).stack ?? String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  private async settle(account: string, rows: Pending[]): Promise<void> {
    const found = await this.withdrawals(account);
    for (const row of rows) {
      const w = found.find((x) => x.ref.blockTimestamp >= Number(row.received_at));
      if (!w) continue;
      const applied = await reconcile(pool, utxo, utxo.key.column, row.id, "withdrawn", {
        utxo_tx: w.utxoTx,
        bridge_fee: w.bridgeFee,
        miner_fee: w.minerFee,
        received: w.received,
        withdrawn: w.ref,
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

  /**
   * The account's withdrawals through any route's connector, oldest first.
   *
   * @param account The derived account.
   */
  private async withdrawals(account: string): Promise<Withdrawal[]> {
    const connectors = new Set(ROUTES.map((r) => r.connector));
    const hashes = (await this.api.history(account)).map((h) => h.transaction_hash);
    const out: Withdrawal[] = [];
    for (const tx of await this.api.transactions(hashes)) {
      const logs = nearLogs(tx).filter((l) => connectors.has(l.executor));
      const pending = logs.find(
        (l) =>
          l.event === "generate_btc_pending_info" &&
          (l.data as { account_id?: string }).account_id === account,
      );
      if (!pending) continue;
      const detail = logs.find((l) => l.event === "withdraw_btc_detail")?.data as
        | { withdraw_fee?: string; btc_gas_fee?: string; actual_received_amount?: string }
        | undefined;
      out.push({
        ref: {
          chain: "near",
          blockNumber: String(pending.blockHeight),
          blockTimestamp: pending.blockTimestamp,
          txHash: tx.transaction.hash,
          logIndex: pending.index,
        },
        utxoTx: (pending.data as { btc_pending_id: string }).btc_pending_id,
        bridgeFee: detail?.withdraw_fee ?? null,
        minerFee: detail?.btc_gas_fee ?? null,
        received: detail?.actual_received_amount ?? null,
      });
    }
    return out.sort((a, b) => a.ref.blockTimestamp - b.ref.blockTimestamp);
  }
}
