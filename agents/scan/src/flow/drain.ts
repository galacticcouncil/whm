import type { PoolClient } from "pg";
import { decodeEventLog } from "viem";

import { legTopic } from "../abi";
import log from "../logger";
import {
  advanceReader,
  applyRebuild,
  deadLetter,
  listenEvents,
  pool,
  readerSeq,
  takeEvents,
  type EventRow,
} from "../db";
import type { Flow, Leg, LogEvent, Watch } from "../types";
import { ddl } from "./schema";
import { broadcast } from "./subscribers";
import { reconcile, type Applied } from "./upsert";

const BATCH = 500;
const ROW_ATTEMPTS = 2;

interface Route {
  flow: Flow;
  leg: Leg;
}

/**
 * Reads the shared event store and merges each event into the flows that claim it.
 *
 * A reader owns one cursor per chain and advances it in the same transaction as the rows it writes,
 * so a crash re-reads rather than loses. An event nothing can process is parked in `dead_events` and
 * skipped, because a poison log must never wedge the queue behind it.
 */
export class Drain {
  private readonly routes = new Map<string, Route[]>();
  private readonly chains: string[];
  private timer?: NodeJS.Timeout;
  private busy = false;
  private again = false;

  /**
   * @param name Reader name — the cursor's identity, and what /api/status reports.
   * @param flows Flows this process owns; nothing else writes their tables.
   * @param watches The watch list, which is what turns a leg's role into addresses.
   */
  constructor(
    private readonly name: string,
    private readonly flows: Flow[],
    watches: Watch[],
  ) {
    const chains = new Set<string>();
    for (const flow of flows) {
      for (const leg of flow.legs) {
        const topic0 = legTopic(leg);
        for (const w of watches.filter((x) => x.role === leg.role)) {
          chains.add(w.chain);
          for (const address of w.at) {
            const key = routeKey(w.chain, address, topic0);
            this.routes.set(key, [...(this.routes.get(key) ?? []), { flow, leg }]);
          }
        }
      }
    }
    this.chains = [...chains];
  }

  /** Create every owned table. Idempotent. */
  async initSchema(): Promise<void> {
    for (const f of this.flows) {
      await pool.query(ddl(f));
      log.info(`  flow: ${f.name} -> ${f.table}`);
    }
  }

  async start(intervalMs: number): Promise<void> {
    if (this.chains.length === 0) {
      log.warn(`[${this.name}] no watch entry matches any flow's roles — nothing to drain`);
      return;
    }
    listenEvents(() => this.trigger());
    await this.run();
    this.timer = setInterval(() => this.trigger(), intervalMs);
    log.info(`[${this.name}] draining ${this.chains.join(", ")}`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Coalesce nudges: a drain already running just gets asked to go round again. */
  trigger(): void {
    if (this.busy) {
      this.again = true;
      return;
    }
    void this.run();
  }

  private async run(): Promise<void> {
    this.busy = true;
    try {
      do {
        this.again = false;
        await this.rebuild();
        for (const chain of this.chains) {
          try {
            await this.drainChain(chain);
          } catch (e) {
            log.error(`[${this.name}/${chain}] ${(e as Error).stack ?? String(e)}`);
          }
        }
      } while (this.again);
    } finally {
      this.busy = false;
    }
  }

  /** Honour a rebuild asked for this reader: its tables emptied, the store replayed from the start. */
  private async rebuild(): Promise<void> {
    try {
      if (
        await applyRebuild(
          this.name,
          this.flows.map((f) => f.table),
        )
      ) {
        log.warn(
          `[${this.name}] rebuilding ${this.flows.map((f) => f.table).join(", ")} from the start`,
        );
      }
    } catch (e) {
      log.error(`[${this.name}] rebuild: ${(e as Error).message}`);
    }
  }

  private async drainChain(chain: string): Promise<void> {
    let total = 0;
    for (;;) {
      const from = await readerSeq(this.name, chain);
      const rows = await takeEvents(chain, from, BATCH);
      if (rows.length === 0) break;
      const updates = await this.applyBatch(chain, rows);
      // A batch that failed as a whole is retried row by row, which isolates the one bad event
      // instead of stalling every event behind it.
      for (const u of updates ?? (await this.applyEachRow(chain, rows))) {
        broadcast({
          flow: u.flow,
          kind: u.created ? "created" : "updated",
          record: u.row,
          previousState: u.previousState,
        });
      }
      total += rows.length;
    }
    if (total > 0) log.info(`[${this.name}/${chain}] processed ${total} events`);
  }

  /**
   * Apply a batch atomically. Updates are returned rather than broadcast so nothing is announced
   * before it is committed.
   *
   * @returns The row changes, or null when the batch rolled back.
   */
  private async applyBatch(chain: string, rows: EventRow[]): Promise<RecordChange[] | null> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const updates: RecordChange[] = [];
      for (const row of rows) updates.push(...(await this.apply(client, row)));
      await advanceReader(client, this.name, chain, BigInt(rows[rows.length - 1].seq));
      await client.query("COMMIT");
      return updates;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      log.warn(`[${this.name}/${chain}] batch failed, isolating: ${(e as Error).message}`);
      return null;
    } finally {
      client.release();
    }
  }

  /**
   * Retry a failed batch one event at a time. An event that still fails is parked and stepped over,
   * so the reader always makes progress.
   */
  private async applyEachRow(chain: string, rows: EventRow[]): Promise<RecordChange[]> {
    const updates: RecordChange[] = [];
    for (const row of rows) {
      let lastError: Error | undefined;
      for (let attempt = 0; attempt < ROW_ATTEMPTS; attempt++) {
        const one = await this.applyBatch(chain, [row]);
        if (one) {
          updates.push(...one);
          lastError = undefined;
          break;
        }
        lastError = new Error("apply failed");
      }
      if (!lastError) continue;
      // Recording the failure is itself a write; if that cannot happen either the database is gone,
      // and stopping with the cursor where it is beats stepping over events blindly.
      await deadLetter(this.name, row, lastError.message);
      await advanceReader(pool, this.name, chain, BigInt(row.seq));
      log.error(`[${this.name}/${chain}] parked ${row.tx_hash}-${row.log_index}`);
    }
    return updates;
  }

  /** Route one raw event to every leg that claims it. */
  private async apply(client: PoolClient, row: EventRow): Promise<RecordChange[]> {
    if (row.topics.length === 0) return [];
    const routes = this.routes.get(routeKey(row.chain, row.address, row.topics[0]));
    if (!routes) return [];

    const out: RecordChange[] = [];
    for (const { flow, leg } of routes) {
      const { eventName, args } = decode(leg, row);

      const ev: LogEvent = {
        chain: row.chain,
        role: leg.role,
        address: row.address,
        sender: row.sender ?? undefined,
        ref: {
          chain: row.chain,
          blockNumber: row.block_number,
          blockTimestamp: Number(row.block_timestamp),
          txHash: row.tx_hash,
          logIndex: row.log_index,
        },
        eventName,
        args,
      };

      const key = await leg.key(ev.args, ev, client);
      if (key === null) continue; // shared infrastructure emits plenty that is not ours

      const keyBy = leg.keyBy ?? flow.key.column;
      const applied = await reconcile(client, flow, keyBy, key, leg.state, leg.patch(ev.args, ev));
      if (!applied) {
        log.warn(`[${this.name}] ${flow.name}: no row with ${keyBy} = ${key}`);
        continue;
      }
      out.push({ flow: flow.name, ...applied });
    }
    return out;
  }
}

interface RecordChange extends Applied {
  flow: string;
}

/**
 * Decode a stored event for a leg: an EVM log by its ABI, a NEAR event from the JSON the watcher
 * stored.
 *
 * @param leg The leg claiming it.
 * @param row The stored event.
 */
function decode(leg: Leg, row: EventRow): { eventName: string; args: Record<string, unknown> } {
  if (leg.near) return { eventName: leg.near.event, args: JSON.parse(row.data) };
  const { eventName, args } = decodeEventLog({
    abi: [leg.abi!],
    topics: row.topics as [`0x${string}`, ...`0x${string}`[]],
    data: row.data as `0x${string}`,
  });
  return { eventName, args: args as Record<string, unknown> };
}

/**
 * A route's identity: chain, emitting address, and event signature. Keyed on the address rather
 * than a name so two flows can watch identically-named events from different contracts.
 */
function routeKey(chain: string, address: string, topic0: string): string {
  return `${chain}:${address.toLowerCase()}:${topic0.toLowerCase()}`;
}
