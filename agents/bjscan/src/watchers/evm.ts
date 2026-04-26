import { type PublicClient, type Log, type Chain } from "viem";

import log from "../logger";
import { insertEvent, loadCursor, saveCursor } from "../db";
import { BoundedQueue } from "../utils";

export interface EvmChainCfg {
  name: string;
  chain: Chain;
  rpcUrl: string;
  contract: `0x${string}`;
  startBlock: bigint;
  confirmations: bigint;
  chunkSize: bigint;
  concurrency: number;
}

type Chunk = { endBlock: bigint; logs: Log[] };

export class EvmWatcher {
  private timer?: NodeJS.Timeout;

  constructor(
    public readonly cfg: EvmChainCfg,
    private readonly client: PublicClient,
    private readonly onIngest?: () => void,
  ) {}

  async latestSafe(): Promise<bigint> {
    const tip = await this.client.getBlockNumber();
    return tip > this.cfg.confirmations ? tip - this.cfg.confirmations : 0n;
  }

  async start(pollIntervalMs: number): Promise<void> {
    const tick = async () => {
      try {
        await this.tick();
      } catch (e) {
        log.error(`[${this.cfg.name}] tick: ${(e as Error).stack ?? String(e)}`);
      }
    };
    await tick();
    this.timer = setInterval(tick, pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const safe = await this.latestSafe();
    const cursor = (await loadCursor(this.cfg.name)) ?? this.cfg.startBlock - 1n;
    if (safe <= cursor) return;
    log.info(`[${this.cfg.name}] indexing ${cursor + 1n}..${safe}`);

    // Two decoupled pipelines: fetcher pulls chunks of logs, processor inserts them
    // into the events table in cursor order, checkpointing per chunk.
    const queue = new BoundedQueue<Chunk>(this.cfg.concurrency * 2);
    const fetchErr: { e?: Error } = {};

    const fetcher = async () => {
      try {
        const inflight: Promise<Chunk>[] = [];
        let next = cursor + 1n;

        const kickoff = (): void => {
          if (next > safe) return;
          const end = next + this.cfg.chunkSize - 1n > safe ? safe : next + this.cfg.chunkSize - 1n;
          const from = next;
          next = end + 1n;
          inflight.push(this.fetchChunk(from, end));
        };

        while (inflight.length < this.cfg.concurrency && next <= safe) kickoff();
        while (inflight.length > 0) {
          const chunk = await inflight.shift()!;
          await queue.push(chunk);
          kickoff();
        }
      } catch (e) {
        fetchErr.e = e as Error;
      } finally {
        queue.close();
      }
    };

    const processor = async () => {
      let ingested = 0;
      let processedBlocks = 0;
      const start = Date.now();
      const total = safe - cursor;
      for (let chunk = await queue.take(); chunk; chunk = await queue.take()) {
        let chunkIngested = 0;
        for (const l of chunk.logs) {
          const ok = await insertEvent(
            this.cfg.name,
            l.transactionHash!,
            l.logIndex!,
            l.blockNumber!,
            l.topics,
            l.data,
          );
          if (ok) {
            ingested++;
            chunkIngested++;
          }
        }
        await saveCursor(this.cfg.name, chunk.endBlock);
        if (chunkIngested > 0) this.onIngest?.();
        processedBlocks = Number(chunk.endBlock - cursor);
        if (processedBlocks < Number(total)) {
          const bps = Math.round(processedBlocks / ((Date.now() - start) / 1000));
          log.info(
            `[${this.cfg.name}] at ${chunk.endBlock} (${processedBlocks} blocks, ${ingested} events, ${bps} blk/s)`,
          );
        }
      }
      if (fetchErr.e) throw fetchErr.e;
      log.info(
        `[${this.cfg.name}] ingested ${ingested} events in ${processedBlocks} blocks, at ${safe}`,
      );
    };

    await Promise.all([fetcher(), processor()]);
  }

  private async fetchChunk(from: bigint, to: bigint): Promise<Chunk> {
    const logs = await this.client.getLogs({
      address: this.cfg.contract,
      fromBlock: from,
      toBlock: to,
    });
    return { endBlock: to, logs };
  }
}
