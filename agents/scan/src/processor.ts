import { decodeEventLog } from "viem";

import log from "./logger";
import { markProcessed, takePendingEvents, type EventRow } from "./db";
import type { EventHandler } from "./types";

/**
 * Routing key for a handler: `${chain}:${address}:${topic0}`. Keying on the emitting
 * address (and topic0, not the event name) lets two features share one ingestion pipeline
 * even when they emit identically-named events (e.g. both Basejump and intents emit
 * `BridgeInitiated`, with different signatures).
 */
export type HandlerRegistry = Map<string, EventHandler>;

/**
 * Build the routing key for an event.
 *
 * @param chain   chain name
 * @param address emitting contract address
 * @param topic0  event signature hash (topics[0])
 */
export function routeKey(chain: string, address: string, topic0: string): string {
  return `${chain}:${address.toLowerCase()}:${topic0.toLowerCase()}`;
}

const BATCH_SIZE = 200;

/**
 * Polls the shared `events` table, decodes each unprocessed event against its registered
 * handler's ABI, and dispatches it. Coalesces watcher nudges so a burst of ingestion
 * triggers a single drain.
 */
export class Processor {
  private timer?: NodeJS.Timeout;
  private draining = false;
  private pending = false;

  constructor(
    private readonly registry: HandlerRegistry,
    private readonly chains: string[],
  ) {}

  async start(pollIntervalMs: number): Promise<void> {
    await this.drainLoop();
    this.timer = setInterval(() => this.trigger(), pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // Coalesce nudges from watchers: if a drain is already running, remember that more work
  // arrived and re-drain once it finishes.
  trigger(): void {
    if (this.draining) {
      this.pending = true;
      return;
    }
    void this.drainLoop();
  }

  private async drainLoop(): Promise<void> {
    this.draining = true;
    try {
      do {
        this.pending = false;
        try {
          await this.drain();
        } catch (e) {
          log.error(`[processor] tick: ${(e as Error).stack ?? String(e)}`);
        }
      } while (this.pending);
    } finally {
      this.draining = false;
    }
  }

  private async drain(): Promise<void> {
    let processed = 0;
    for (;;) {
      const rows = await takePendingEvents(BATCH_SIZE, this.chains);
      if (rows.length === 0) break;
      for (const row of rows) await this.apply(row);
      processed += rows.length;
    }
    if (processed > 0) log.info(`[processor] processed ${processed} events`);
  }

  private async apply(row: EventRow): Promise<void> {
    if (row.topics.length === 0) {
      await markProcessed(row.chain, row.tx_hash, row.log_index);
      return;
    }
    const handler = this.registry.get(routeKey(row.chain, row.address, row.topics[0]));
    if (handler) {
      try {
        const { eventName, args } = decodeEventLog({
          abi: [handler.abi],
          topics: row.topics as [`0x${string}`, ...`0x${string}`[]],
          data: row.data as `0x${string}`,
        });
        await handler.handle({
          chain: row.chain,
          address: row.address,
          ref: {
            chain: row.chain,
            blockNumber: row.block_number,
            txHash: row.tx_hash as `0x${string}`,
            logIndex: row.log_index,
          },
          eventName,
          args: args as Record<string, unknown>,
        });
      } catch (err) {
        // unknown signature or handler threw — log but don't block the queue
        log.warn(
          `[processor] skip ${row.chain} ${row.tx_hash}-${row.log_index}: ${(err as Error).message}`,
        );
      }
    }
    await markProcessed(row.chain, row.tx_hash, row.log_index);
  }
}
