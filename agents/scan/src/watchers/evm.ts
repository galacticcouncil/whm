import { createPublicClient, webSocket, type PublicClient, type WebSocketTransport } from "viem";
import { watchBlockNumber } from "viem/actions";

import log from "../logger";
import { applyRewinds, insertEvents, loadCursor, saveCursor, type RawEvent } from "../db";
import { BoundedQueue } from "../utils";
import { cursorId } from "./cursor";
import { liveIntervalMs } from "../config";
import type { EvmChain, Watch } from "../types";

const HEAD_STALE_MS = 60_000;
const TIME_CACHE_MAX = 20_000;

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
 * Backfills and live-tails an EVM chain. New heads arrive over a websocket subscription and update
 * a cached tip; ingestion runs off that tip on a backstop interval, so the node is never polled for
 * a block number.
 *
 * Each watch entry is indexed independently against its own cursor. That is what lets a contract be
 * added later and backfilled from its own deploy block while everything else stays at the tip.
 */
export class EvmWatcher {
  readonly client: PublicClient;
  private timer?: NodeJS.Timeout;
  private unwatch?: () => void;
  private tip?: bigint;
  private lastHeadAt = 0;
  private busy = false;
  private times = new Map<bigint, number>();

  constructor(
    public readonly cfg: EvmChain,
    private readonly watches: Watch[],
    private readonly onIngest?: (chain: string) => void,
  ) {
    this.client = createPublicClient({
      chain: cfg.chain,
      transport: webSocket(cfg.rpcUrl, {
        keepAlive: { interval: 30_000 },
        reconnect: { attempts: Infinity, delay: 2_000 },
      }),
    });
  }

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
      await applyRewinds(this.cfg.name, this.watches.map(cursorId));
      // Sequential across roles: each already fans out internally, and normally every role is at
      // the tip so this is one small range each.
      for (const w of this.watches) await this.tick(w, safe);
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

  private async tick(w: Watch, safe: bigint): Promise<void> {
    const cursor = (await loadCursor(this.cfg.name, cursorId(w))) ?? w.from - 1n;
    if (safe <= cursor) return;
    const backfill = safe - cursor > this.cfg.chunkSize;
    if (backfill) log.info(`[${this.cfg.name}/${cursorId(w)}] indexing ${cursor + 1n}..${safe}`);

    // Two decoupled pipelines: the fetcher pulls chunks of logs concurrently, the writer inserts
    // them in cursor order and checkpoints per chunk.
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
          inflight.push(this.fetchChunk(w, from, end));
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

    const writer = async () => {
      let ingested = 0;
      const start = Date.now();
      for (let chunk = await queue.take(); chunk; chunk = await queue.take()) {
        const n = await this.write(w, chunk.logs);
        await saveCursor(this.cfg.name, cursorId(w), chunk.endBlock);
        if (n > 0) this.onIngest?.(this.cfg.name);
        ingested += n;
        if (backfill && chunk.endBlock < safe) {
          const done = Number(chunk.endBlock - cursor);
          const bps = Math.round(done / ((Date.now() - start) / 1000));
          log.info(
            `[${this.cfg.name}/${cursorId(w)}] at ${chunk.endBlock} (${done} blocks, ${ingested} events, ${bps} blk/s)`,
          );
        }
      }
      if (fetchErr.e) throw fetchErr.e;
      if (backfill || ingested > 0) {
        log.info(`[${this.cfg.name}/${cursorId(w)}] ingested ${ingested} events, at ${safe}`);
      }
    };

    await Promise.all([fetcher(), writer()]);
  }

  /** Attach block timestamps, and senders where the watch asks for them, then store the batch. */
  private async write(w: Watch, logs: RawLog[]): Promise<number> {
    if (logs.length === 0) return 0;
    const [times, senders] = await Promise.all([
      this.blockTimes(logs.map((l) => BigInt(l.blockNumber))),
      w.sender ? this.senders(logs.map((l) => l.transactionHash)) : undefined,
    ]);
    const events: RawEvent[] = logs.map((l) => ({
      txHash: l.transactionHash,
      logIndex: Number(BigInt(l.logIndex)),
      address: l.address,
      blockNumber: BigInt(l.blockNumber),
      blockTimestamp: times.get(BigInt(l.blockNumber)) ?? 0,
      topics: l.topics,
      data: l.data,
      sender: senders?.get(l.transactionHash),
    }));
    return insertEvents(this.cfg.name, events);
  }

  /**
   * Who sent each transaction. Only for watches that ask, and only for transactions that already
   * produced a log we index, so this never walks a chain.
   *
   * @param hashes Transaction hashes, with duplicates.
   */
  private async senders(hashes: `0x${string}`[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const uniq = [...new Set(hashes)];
    for (let i = 0; i < uniq.length; i += this.cfg.concurrency) {
      const slice = uniq.slice(i, i + this.cfg.concurrency);
      const txs = await Promise.all(
        slice.map(
          (h) =>
            this.client.request({
              method: "eth_getTransactionByHash",
              params: [h],
            }) as Promise<{ from: string } | null>,
        ),
      );
      txs.forEach((tx, j) => {
        if (tx) out.set(slice[j], tx.from.toLowerCase());
      });
    }
    return out;
  }

  /**
   * Block timestamps in unix ms, fetched once per block and cached. Only blocks that produced a log
   * are ever asked for, so this is a fraction of the range.
   *
   * @param numbers Block numbers, with duplicates.
   */
  private async blockTimes(numbers: bigint[]): Promise<Map<bigint, number>> {
    const missing = [...new Set(numbers)].filter((n) => !this.times.has(n));
    for (let i = 0; i < missing.length; i += this.cfg.concurrency) {
      const slice = missing.slice(i, i + this.cfg.concurrency);
      const blocks = await Promise.all(
        slice.map(
          (n) =>
            this.client.request({
              method: "eth_getBlockByNumber",
              params: [`0x${n.toString(16)}`, false],
            }) as Promise<{ timestamp: `0x${string}` } | null>,
        ),
      );
      blocks.forEach((b, j) => {
        if (b) this.times.set(slice[j], Number(BigInt(b.timestamp)) * 1000);
      });
    }
    if (this.times.size > TIME_CACHE_MAX) this.times.clear();
    return this.times;
  }

  /** One getLogs for the watch's addresses, carrying its own topic filter. */
  private async fetchChunk(w: Watch, from: bigint, to: bigint): Promise<Chunk> {
    const logs = (await this.client.request({
      method: "eth_getLogs",
      params: [
        {
          address: w.at as `0x${string}`[],
          topics: w.topics ?? [],
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
        },
      ],
    })) as RawLog[];
    return { endBlock: to, logs };
  }
}
