import { decodeEventLog, type AbiEvent } from "viem";

import log from "../logger";
import { markProcessed, takePendingEvents, type EventRow, type LogEvent } from "../db";

export interface EventHandler {
  abi: AbiEvent;
  handle: (ev: LogEvent) => Promise<void> | void;
}

export type HandlerMap = Record<string, EventHandler>;

const BATCH_SIZE = 200;

export class Processor {
  private abis: AbiEvent[];
  private timer?: NodeJS.Timeout;

  constructor(private handlers: HandlerMap) {
    this.abis = Object.values(handlers).map((h) => h.abi);
  }

  async start(pollIntervalMs: number): Promise<void> {
    const tick = async () => {
      try {
        await this.drain();
      } catch (e) {
        log.error(`[processor] tick: ${(e as Error).stack ?? String(e)}`);
      }
    };
    await tick();
    this.timer = setInterval(tick, pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async drain(): Promise<void> {
    let processed = 0;
    for (;;) {
      const rows = await takePendingEvents(BATCH_SIZE);
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
    try {
      const { eventName, args } = decodeEventLog({
        abi: this.abis,
        topics: row.topics as [`0x${string}`, ...`0x${string}`[]],
        data: row.data as `0x${string}`,
      });
      const handler = this.handlers[eventName];
      if (handler) {
        await handler.handle({
          chain: row.chain,
          ref: {
            chain: row.chain,
            blockNumber: row.block_number,
            txHash: row.tx_hash as `0x${string}`,
            logIndex: row.log_index,
          },
          eventName,
          args: args as Record<string, unknown>,
        });
      }
    } catch (err) {
      // unknown signature or handler threw — log but don't block the queue
      log.warn(
        `[processor] skip ${row.chain} ${row.tx_hash}-${row.log_index}: ${(err as Error).message}`,
      );
    }
    await markProcessed(row.chain, row.tx_hash, row.log_index);
  }
}
