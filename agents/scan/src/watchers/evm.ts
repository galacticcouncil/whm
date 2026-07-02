import { type PublicClient, type WebSocketTransport } from "viem";
import { watchBlockNumber } from "viem/actions";

import log from "../logger";
import { insertEvent, loadCursor, saveCursor } from "../db";
import { BoundedQueue } from "../utils";
import { liveIntervalMs } from "../config";
import type { EvmChain } from "../types";

const HEAD_STALE_MS = 60_000;

/** A contract address to fetch logs for, with an optional topic filter to narrow a firehose emitter. */
export interface WatchedAddress {
  address: `0x${string}`;
  topics?: (`0x${string}` | null)[];
}

interface RawLog {
  address: `0x${string}`;
  topics: `0x${string}`[];
  data: `0x${string}`;
  blockNumber: `0x${string}`;
  transactionHash: `0x${string}`;
  logIndex: `0x${string}`;
}

type Chunk = { endBlock: bigint; logs: RawLog[] };

/**
 * Backfills + live-tails an EVM chain. New heads arrive over a WSS `eth_subscribe`
 * (`watchBlockNumber({ poll: false })`) and update the cached `tip`; ingestion runs off that
 * cached tip on a backstop interval, so we never poll the node for the block number. Logs are
 * fetched per watched contract (each may carry its own topic filter) and written to the shared
 * `events` table in cursor order, checkpointing per chunk.
 */
export class EvmWatcher {
  private timer?: NodeJS.Timeout;
  private unwatch?: () => void;
  private tip?: bigint;
  private lastHeadAt = 0;
  private busy = false;

  constructor(
    public readonly cfg: EvmChain,
    private readonly contracts: WatchedAddress[],
    private readonly client: PublicClient,
    private readonly onIngest?: () => void,
  ) {}

  async latestSafe(): Promise<bigint> {
    const tip = await this.client.getBlockNumber();
    return tip > this.cfg.confirmations ? tip - this.cfg.confirmations : 0n;
  }

  async start(): Promise<void> {
    this.lastHeadAt = Date.now();
    this.watch();
    await this.ingest();
    this.timer = setInterval(() => void this.ingest(), liveIntervalMs);
    log.info(`[${this.cfg.name}] live: new-heads subscription (sweep every ${liveIntervalMs}ms)`);
  }

  stop(): void {
    this.unwatch?.();
    if (this.timer) clearInterval(this.timer);
  }

  private watch(): void {
    this.unwatch?.();
    this.unwatch = watchBlockNumber(this.client as PublicClient<WebSocketTransport>, {
      poll: false,
      onBlockNumber: (n) => {
        this.tip = n;
        this.lastHeadAt = Date.now();
      },
      onError: (e) => {
        log.error(`[${this.cfg.name}] ws: ${e.message}`);
        setTimeout(() => this.watch(), 5_000);
      },
    });
  }

  private async ingest(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const stale = Date.now() - this.lastHeadAt > HEAD_STALE_MS;
      const safe =
        !stale && this.tip !== undefined && this.tip > this.cfg.confirmations
          ? this.tip - this.cfg.confirmations
          : await this.latestSafe();
      await this.tick(safe);
      if (stale) {
        log.warn(`[${this.cfg.name}] heads stale, re-subscribing`);
        this.watch();
      }
    } catch (e) {
      log.error(`[${this.cfg.name}] ingest: ${(e as Error).stack ?? String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  private async tick(safeHint?: bigint): Promise<void> {
    const safe = safeHint ?? (await this.latestSafe());
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
            l.transactionHash,
            Number(BigInt(l.logIndex)),
            l.address,
            BigInt(l.blockNumber),
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

  /** Fetch every watched contract's logs for a block range, each with its own topic filter. */
  private async fetchChunk(from: bigint, to: bigint): Promise<Chunk> {
    const fromBlock = `0x${from.toString(16)}` as const;
    const toBlock = `0x${to.toString(16)}` as const;
    const perContract = await Promise.all(
      this.contracts.map(
        (c) =>
          this.client.request({
            method: "eth_getLogs",
            params: [{ address: c.address, topics: c.topics ?? [], fromBlock, toBlock }],
          }) as Promise<RawLog[]>,
      ),
    );
    return { endBlock: to, logs: perContract.flat() };
  }
}
