import { HydrationEvents } from "@galacticcouncil/descriptors";
import { PolkadotClient } from "polkadot-api";

import log from "../logger.js";
import { insertEvent, loadCursor, saveCursor } from "../db.js";
import { BoundedQueue } from "../queue.js";

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

  constructor(
    public readonly cfg: SubstrateChainCfg,
    private readonly client: PolkadotClient,
  ) {}

  async latestSafe(): Promise<bigint> {
    const { number } = await this.client.getFinalizedBlock();
    const tip = BigInt(number);
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
    this.client?.destroy();
  }

  private async tick(): Promise<void> {
    const safe = await this.latestSafe();
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
          if (ok) ingested++;
        }
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
