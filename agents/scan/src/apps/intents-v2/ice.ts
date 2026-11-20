import { createClient, type PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";

import { CHAINS } from "../../chains";
import { pool } from "../../db";
import { broadcast, reconcile } from "../../flow";
import log from "../../logger";

import { orders } from "./flows";

/** How often orders still without their intent's planned trades are looked up. */
const POLL_MS = 30_000;

/** An ICE intent as `Intent.Intents` stores it, as far as it is read. */
interface StoredIntent {
  data: { type: string; value: { amount_in?: bigint; budget?: bigint } };
}

let client: PolkadotClient | null | undefined;

/** One Hydration connection, opened on first use and kept. */
function hydration(): PolkadotClient | null {
  if (client !== undefined) return client;
  const cfg = CHAINS["hydration"];
  client = cfg && cfg.kind === "substrate" ? createClient(getWsProvider(cfg.wssUrl)) : null;
  return client;
}

/** Each intent's planned trades — fixed when it is submitted, so read once. */
const planned = new Map<string, Promise<number | null>>();

/**
 * How many trades an ICE intent was submitted for: a swap one, a DCA its budget over its amount per
 * trade. ICE drops an intent once it has run, so a DCA is read at the block before its first order,
 * while it still has trades to run — which takes an archive node.
 *
 * @param intentId The ICE intent id, as `OrderSourced` names it.
 * @param block The Hydration block of the intent's first order.
 * @returns The planned trades, or null when Hydration is not configured or cannot say.
 */
export function plannedTrades(intentId: string, block: number): Promise<number | null> {
  let p = planned.get(intentId);
  if (!p) {
    p = (async () => {
      const c = hydration();
      if (!c) return null;
      const at = (await c._request("chain_getBlockHash", [block - 1])) as string;
      const intent = (await c.getUnsafeApi().query.Intent.Intents.getValue(BigInt(intentId), { at })) as
        | StoredIntent
        | undefined;
      // Gone by then: a swap is dropped as it resolves, before its forward lands; a DCA stays until
      // its last trade, so only a single-trade one is gone at its first order. Either way, one trade.
      if (!intent || intent.data.type === "Swap") return 1;
      const { amount_in, budget } = intent.data.value;
      if (intent.data.type !== "Dca" || !amount_in || budget == null) return null;
      return Number((budget + amount_in - 1n) / amount_in);
    })().catch((e) => {
      log.warn(`[intents-v2] intent ${intentId} planned trades: ${(e as Error).message}`);
      planned.delete(intentId);
      return null;
    });
    planned.set(intentId, p);
  }
  return p;
}

/**
 * Fills each order's `planned` from its ICE intent, so a trade's status can tell a finished TWAP from
 * one between orders. Written with the lowest state, which never moves an order's own.
 */
export class PlannedPoller {
  private timer?: NodeJS.Timeout;
  private busy = false;

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    log.info(`[intents-v2] planned poller: every ${POLL_MS}ms`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const pending = await pool.query(
        `SELECT intent_id::text AS intent_id,
                MIN((published->>'blockNumber')::bigint) AS block,
                ARRAY_AGG(seq::text) FILTER (WHERE planned IS NULL) AS seqs
           FROM intent_v2_orders
          WHERE intent_id IS NOT NULL AND published IS NOT NULL
          GROUP BY intent_id
         HAVING BOOL_OR(planned IS NULL)`,
      );
      for (const r of pending.rows as { intent_id: string; block: string; seqs: string[] }[]) {
        const n = await plannedTrades(r.intent_id, Number(r.block));
        if (n == null) continue;
        for (const seq of r.seqs) {
          const applied = await reconcile(pool, orders, orders.key.column, seq, "published", { planned: n });
          if (applied) {
            broadcast({ flow: orders.name, kind: "updated", record: applied.row, previousState: applied.previousState });
          }
        }
      }
    } catch (e) {
      log.error(`[intents-v2] planned tick: ${(e as Error).stack ?? String(e)}`);
    } finally {
      this.busy = false;
    }
  }
}
