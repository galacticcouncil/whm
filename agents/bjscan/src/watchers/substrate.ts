import { HydrationEvents } from "@galacticcouncil/descriptors";
import { PolkadotClient } from "polkadot-api";

import log from "../logger";
import { insertEvent, loadCursor, saveCursor } from "../db";
import { BoundedQueue } from "../utils";
import { liveIntervalMs } from "../config";

const FINALIZED_STALE_MS = 60_000;

export interface SubstrateChainCfg {
  name: string;
  chainId: number;
  wssUrl: string;
  contract: `0x${string}`;
  startBlock: bigint;
  confirmations: bigint;
  concurrency: number;
  checkpointEvery: number;
}

type EvmPayload = HydrationEvents["EVM"]["Log"];
type IndexedLog = {
  index: number;
  topics: `0x${string}`[];
  data: `0x${string}`;
};
type Block = { number: bigint; hash: `0x${string}`; logs: IndexedLog[] };

export class SubstrateWatcher {
  private timer?: NodeJS.Timeout;
  private sub?: { unsubscribe(): void };
  private pendingSafe?: bigint;
  private lastBlockAt = 0;
  private busy = false;

  constructor(
    public readonly cfg: SubstrateChainCfg,
    private readonly client: PolkadotClient,
    private readonly onIngest?: () => void,
  ) {}

  async latestSafe(): Promise<bigint> {
    const { number } = await this.client.getFinalizedBlock();
    const tip = BigInt(number);
    return tip > this.cfg.confirmations ? tip - this.cfg.confirmations : 0n;
  }

  async start(): Promise<void> {
    this.lastBlockAt = Date.now();
    this.pendingSafe = await this.latestSafe();
    await this.drain();
    this.subscribe();
    this.timer = setInterval(() => void this.drain(), liveIntervalMs);
    log.info(`[${this.cfg.name}] live: finalized-block subscription`);
  }

  stop(): void {
    this.sub?.unsubscribe();
    if (this.timer) clearInterval(this.timer);
    this.client?.destroy();
  }

  // ─── live tail ───────────────────────────────────────────────────

  private subscribe(): void {
    this.sub?.unsubscribe();
    this.sub = this.client.finalizedBlock$.subscribe({
      next: (b) => {
        const n = BigInt(b.number);
        this.pendingSafe = n > this.cfg.confirmations ? n - this.cfg.confirmations : 0n;
        this.lastBlockAt = Date.now();
        void this.drain();
      },
      error: (e) => {
        log.error(`[${this.cfg.name}] finalizedBlock$: ${(e as Error)?.message ?? String(e)}`);
        setTimeout(() => this.subscribe(), 5_000);
      },
    });
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const stale = Date.now() - this.lastBlockAt > FINALIZED_STALE_MS;
      if (this.pendingSafe === undefined && stale) this.pendingSafe = await this.latestSafe();
      while (this.pendingSafe !== undefined) {
        const safe = this.pendingSafe;
        this.pendingSafe = undefined;
        await this.tick(safe);
      }
      if (stale) {
        log.warn(`[${this.cfg.name}] finalized stream stale, re-subscribing`);
        this.subscribe();
      }
    } catch (e) {
      log.error(`[${this.cfg.name}] drain: ${(e as Error).stack ?? String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  private async tick(safeHint?: bigint): Promise<void> {
    const safe = safeHint ?? (await this.latestSafe());
    const cursor = (await loadCursor(this.cfg.name)) ?? this.cfg.startBlock - 1n;
    if (safe <= cursor) return;
    log.info(`[${this.cfg.name}] indexing ${cursor + 1n}..${safe}`);

    // Two decoupled pipelines: fetcher pulls blocks, processor inserts matching
    // EVM.Log events into the events table in block order, checkpoints periodically.
    const queue = new BoundedQueue<Block>(this.cfg.concurrency * 2);
    const fetchErr: { e?: Error } = {};

    const fetcher = async () => {
      try {
        const inflight: Promise<Block>[] = [];
        let next = cursor + 1n;
        while (inflight.length < this.cfg.concurrency && next <= safe) {
          inflight.push(this.fetchBlock(next++));
        }
        while (inflight.length > 0) {
          const block = await inflight.shift()!;
          await queue.push(block);
          if (next <= safe) inflight.push(this.fetchBlock(next++));
        }
      } catch (e) {
        fetchErr.e = e as Error;
      } finally {
        queue.close();
      }
    };

    const processor = async () => {
      let ingested = 0;
      let processed = 0;
      let lastCheckpoint = cursor;
      const start = Date.now();
      for (let block = await queue.take(); block; block = await queue.take()) {
        let blockIngested = 0;
        for (const l of block.logs) {
          const txHash = `${block.hash}-${l.index}`;
          const ok = await insertEvent(
            this.cfg.name,
            txHash,
            l.index,
            block.number,
            l.topics,
            l.data,
          );
          if (ok) {
            ingested++;
            blockIngested++;
          }
        }
        if (blockIngested > 0) this.onIngest?.();
        processed++;
        if (block.number - lastCheckpoint >= BigInt(this.cfg.checkpointEvery)) {
          await saveCursor(this.cfg.name, block.number);
          const bps = Math.round(processed / ((Date.now() - start) / 1000));
          log.info(
            `[${this.cfg.name}] at ${block.number} (${processed} blocks, ${ingested} events, ${bps} blk/s)`,
          );
          lastCheckpoint = block.number;
        }
      }
      if (fetchErr.e) throw fetchErr.e;
      await saveCursor(this.cfg.name, safe);
      log.info(`[${this.cfg.name}] ingested ${ingested} events in ${processed} blocks, at ${safe}`);
    };

    await Promise.all([fetcher(), processor()]);
  }

  private async fetchBlock(n: bigint): Promise<Block> {
    const hash = await this.client._request<string>("chain_getBlockHash", [Number(n)]);
    if (!hash) throw new Error(`block #${n}: no hash`);
    const records = await this.client.getUnsafeApi().query.System.Events.getValue({ at: hash });
    return {
      number: n,
      hash: hash as `0x${string}`,
      logs: extractEvmLogs(records, this.cfg.contract),
    };
  }
}

// ─── helpers ─────────────────────────────────────────────────────

type RawRecord = {
  event: { type: string; value: { type: string; value: unknown } };
};

function extractEvmLogs(records: RawRecord[], address: string): IndexedLog[] {
  const target = address.toLowerCase();
  const out: IndexedLog[] = [];
  for (let i = 0; i < records.length; i++) {
    const evt = records[i].event;
    if (evt.type !== "EVM" || evt.value.type !== "Log") continue;
    const { log } = evt.value.value as EvmPayload;
    const addr = log.address.asHex();
    if (addr.toLowerCase() !== target) continue;
    out.push({
      index: i,
      topics: log.topics.map((t) => t.asHex()),
      data: log.data.asHex(),
    });
  }
  return out;
}
