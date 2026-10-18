import { HydrationEvents } from "@galacticcouncil/descriptors";
import { createClient, PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { bytesToHex } from "viem";

import { liveIntervalMs } from "../../config";
import { applyRewinds, insertEvents, loadCursor, saveCursor, type RawEvent } from "../../db";
import log from "../../logger";
import type { Watch } from "../../types";
import { BoundedQueue } from "../../utils";
import { cursorId } from "../cursor";

import { PROGRESS_LOG_MS, RANGE, SYSTEM_EVENTS_KEY } from "./consts";
import type { SubstrateChain } from "./types";

const FINALIZED_STALE_MS = 60_000;

/** Any single read. A request lost to a dropped socket never settles on its own. */
const RPC_TIMEOUT_MS = 60_000;

/** A drain in flight this long without writing a block is wedged, not slow. */
const STALL_MS = 10 * 60_000;

type EvmPayload = HydrationEvents["EVM"]["Log"];

interface IndexedLog {
  index: number;
  address: string;
  topics: `0x${string}`[];
  data: `0x${string}`;
  /** The ethereum transaction this log belongs to, where the call came in as one. */
  txHash?: string;
  /** Who sent that transaction. Free here, unlike on an EVM chain. */
  sender?: string;
}

type Block = { number: bigint; hash: `0x${string}`; timestamp: number; logs: IndexedLog[] };

/**
 * Backfills and live-tails a substrate chain's EVM.Log events. Finalized blocks arrive over a
 * websocket subscription and drive ingestion directly; the interval is only a backstop.
 *
 * Unlike the EVM watcher, blocks are read whole rather than filtered by the node, so one pass serves
 * every role at the same height. A role added later with an older start block pulls the scan back
 * for all of them — the reads are shared, and the inserts are idempotent.
 */
export class SubstrateWatcher {
  readonly client: PolkadotClient;
  private timer?: NodeJS.Timeout;
  private sub?: { unsubscribe(): void };
  private pendingSafe?: bigint;
  private lastBlockAt = 0;
  private busy = false;
  /** Last time a drain started or wrote a block — what the watchdog measures a stall against. */
  private progressAt = 0;
  /** Watch entries by emitting address — one address may serve several roles. */
  private readonly targets = new Map<string, Watch[]>();
  /** The same addresses as bare hex, searched for in a block's raw events before decoding them. */
  private readonly needles: string[];

  constructor(
    public readonly cfg: SubstrateChain,
    private readonly watches: Watch[],
    private readonly onIngest?: (chain: string) => void,
  ) {
    this.client = createClient(getWsProvider(cfg.wssUrl));
    for (const w of watches) {
      for (const a of w.at) {
        const key = a.toLowerCase();
        this.targets.set(key, [...(this.targets.get(key) ?? []), w]);
      }
    }
    this.needles = [...this.targets.keys()].map((a) => a.replace(/^0x/, ""));
  }

  async latestSafe(): Promise<bigint> {
    const { number } = await withTimeout(this.client.getFinalizedBlock(), "finalized block");
    const tip = BigInt(number);
    return tip > this.cfg.confirmations ? tip - this.cfg.confirmations : 0n;
  }

  async start(): Promise<void> {
    this.lastBlockAt = Date.now();
    this.pendingSafe = await this.latestSafe();
    await this.drain();
    this.subscribe();
    this.timer = setInterval(() => {
      this.watchdog();
      void this.drain();
    }, liveIntervalMs);
    log.info(`[${this.cfg.name}] live: finalized-block subscription`);
  }

  stop(): void {
    this.sub?.unsubscribe();
    if (this.timer) clearInterval(this.timer);
    this.client?.destroy();
  }

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

  /**
   * Exit when a drain has hung. A drain holds `busy` until it settles, and every later drain —
   * stale-stream recovery included — returns early behind it, so a hang is otherwise silent and
   * permanent. Exiting hands recovery to the orchestrator: a fresh process, a fresh client, and the
   * cursor resumes where it was.
   */
  private watchdog(): void {
    if (!this.busy || Date.now() - this.progressAt < STALL_MS) return;
    log.error(`[${this.cfg.name}] drain stalled for ${STALL_MS / 60_000} min, exiting`);
    process.exit(1);
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.progressAt = Date.now();
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

  /** Each role's cursor, defaulted to just before its own start block. */
  private async cursors(): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    for (const w of this.watches) {
      out.set(cursorId(w), (await loadCursor(this.cfg.name, cursorId(w))) ?? w.from - 1n);
    }
    return out;
  }

  private async tick(safe: bigint): Promise<void> {
    await applyRewinds(this.cfg.name, this.watches.map(cursorId));
    const cursors = await this.cursors();
    const from = [...cursors.values()].reduce((a, b) => (b < a ? b : a));
    if (safe <= from) return;
    const backfill = safe - from > BigInt(this.cfg.checkpointEvery);
    if (backfill) log.info(`[${this.cfg.name}] indexing ${from + 1n}..${safe}`);

    // Two decoupled pipelines: the fetcher pulls blocks concurrently, the writer inserts matching
    // logs in block order and checkpoints periodically.
    const queue = new BoundedQueue<Block>(this.cfg.concurrency * 2);
    const fetchErr: { e?: Error } = {};

    const fetcher = async () => {
      // Ranges in flight, sized off the per-block concurrency the config already names.
      const parallel = Math.max(1, Math.ceil(this.cfg.concurrency / 20));
      const inflight: Promise<Block[]>[] = [];
      try {
        let next = from + 1n;
        const kickoff = (): void => {
          if (next > safe) return;
          const end = next + RANGE - 1n > safe ? safe : next + RANGE - 1n;
          inflight.push(this.fetchRange(next, end));
          next = end + 1n;
        };
        while (inflight.length < parallel && next <= safe) kickoff();
        while (inflight.length > 0) {
          for (const block of await inflight.shift()!) await queue.push(block);
          kickoff();
        }
      } catch (e) {
        fetchErr.e = e as Error;
        // The rest are abandoned — keep their later rejections from going unhandled.
        for (const p of inflight) p.catch(() => {});
      } finally {
        queue.close();
      }
    };

    const writer = async () => {
      let ingested = 0;
      let processed = 0;
      let lastCheckpoint = from;
      const start = Date.now();
      let loggedAt = start;
      for (let block = await queue.take(); block; block = await queue.take()) {
        const events: RawEvent[] = block.logs
          .filter((l) => this.wanted(l, block.number, cursors))
          .map((l) => ({
            // The ethereum transaction where the call came in as one. Where it did not — the
            // XCM-driven deliveries — there is no such transaction, and the block hash plus the
            // event index is the only identity the log has.
            txHash: l.txHash ?? `${block.hash}-${l.index}`,
            logIndex: l.index,
            address: l.address,
            blockNumber: block.number,
            blockTimestamp: block.timestamp,
            topics: l.topics,
            data: l.data,
            sender: l.sender,
          }));
        const n = await insertEvents(this.cfg.name, events);
        if (n > 0) this.onIngest?.(this.cfg.name);
        ingested += n;
        processed++;
        this.progressAt = Date.now();
        if (block.number - lastCheckpoint >= BigInt(this.cfg.checkpointEvery)) {
          await this.checkpoint(block.number, cursors);
          lastCheckpoint = block.number;
          if (Date.now() - loggedAt >= PROGRESS_LOG_MS) {
            const bps = Math.round(processed / ((Date.now() - start) / 1000));
            log.info(
              `[${this.cfg.name}] at ${block.number} (${processed} blocks, ${ingested} events, ${bps} blk/s)`,
            );
            loggedAt = Date.now();
          }
        }
      }
      if (fetchErr.e) throw fetchErr.e;
      await this.checkpoint(safe, cursors);
      if (backfill || ingested > 0) {
        log.info(
          `[${this.cfg.name}] ingested ${ingested} events in ${processed} blocks, at ${safe}`,
        );
      }
    };

    await Promise.all([fetcher(), writer()]);
  }

  /** Advance every role that has actually been covered up to `block`. */
  private async checkpoint(block: bigint, cursors: Map<string, bigint>): Promise<void> {
    for (const w of this.watches) {
      const at = cursors.get(cursorId(w))!;
      if (block <= at) continue;
      await saveCursor(this.cfg.name, cursorId(w), block);
      cursors.set(cursorId(w), block);
    }
  }

  /** Whether a log belongs to a watch that has not already covered this block. */
  private wanted(l: IndexedLog, block: bigint, cursors: Map<string, bigint>): boolean {
    const matches = this.targets.get(l.address) ?? [];
    return matches.some((w) => cursors.get(cursorId(w))! < block && topicsMatch(w, l.topics));
  }

  /**
   * A range of blocks: their hashes in one call, their events in one more.
   *
   * `state_queryStorage` returns `System.Events` for every block in the range where it changed, so
   * a block it leaves out held the same bytes as the one before it. A node that refuses the call is
   * read one block at a time instead — slower, never wrong.
   *
   * @param start First block.
   * @param end Last block, inclusive.
   */
  private async fetchRange(start: bigint, end: bigint): Promise<Block[]> {
    const numbers: number[] = [];
    for (let n = start; n <= end; n++) numbers.push(Number(n));
    const hashes = await withTimeout(
      this.client._request<(string | null)[]>("chain_getBlockHash", [numbers]),
      `blocks #${start}..${end} hashes`,
    );
    hashes.forEach((h, i) => {
      if (!h) throw new Error(`block #${numbers[i]}: no hash`);
    });

    let raw: Map<string, string | null>;
    try {
      const sets = await withTimeout(
        this.client._request<{ block: string; changes: [string, string | null][] }[]>(
          "state_queryStorage",
          [[SYSTEM_EVENTS_KEY], hashes[0], hashes[hashes.length - 1]],
        ),
        `blocks #${start}..${end} events`,
      );
      raw = new Map(sets.map((c) => [c.block, c.changes[0]?.[1] ?? null]));
      if (!raw.has(hashes[0]!)) raw.set(hashes[0]!, await this.rawEvents(hashes[0]!, start));
    } catch (e) {
      log.warn(`[${this.cfg.name}] #${start}..${end}: ${(e as Error).message}, reading per block`);
      raw = new Map(
        await Promise.all(
          hashes.map(async (h, i) => [h!, await this.rawEvents(h!, BigInt(numbers[i]))] as const),
        ),
      );
    }

    let last: string | null = null;
    return Promise.all(
      hashes.map((h, i) => {
        if (raw.has(h!)) last = raw.get(h!)!;
        return this.block(BigInt(numbers[i]), h as `0x${string}`, last);
      }),
    );
  }

  /** One block's `System.Events`, raw. */
  private rawEvents(at: string, n: bigint): Promise<string | null> {
    return withTimeout(
      this.client._request<string | null>("state_getStorage", [SYSTEM_EVENTS_KEY, at]),
      `block #${n} events`,
    );
  }

  /**
   * One block from its raw events. Nearly every block has nothing for us, so the events are decoded
   * only when a watched address appears in their bytes — an `EVM.Log` carries its emitter as the
   * raw 20 bytes, so a block without them cannot hold one. A match on other bytes only costs a
   * decode.
   *
   * @param n The block.
   * @param at Its hash.
   * @param raw Its `System.Events`, raw.
   */
  private async block(n: bigint, at: `0x${string}`, raw: string | null): Promise<Block> {
    const hex = raw?.toLowerCase() ?? "";
    if (!this.needles.some((x) => hex.includes(x))) {
      return { number: n, hash: at, timestamp: 0, logs: [] };
    }

    const records = await withTimeout(
      this.client.getUnsafeApi().query.System.Events.getValue({ at }),
      `block #${n} events`,
    );
    const logs = this.extractEvmLogs(records as unknown as RawRecord[]);
    // Only blocks that produced something we index are worth a timestamp read.
    const timestamp = logs.length
      ? Number(
          await withTimeout(
            this.client.getUnsafeApi().query.Timestamp.Now.getValue({ at }),
            `block #${n} timestamp`,
          ),
        )
      : 0;
    return { number: n, hash: at, timestamp, logs };
  }

  /**
   * Pull EVM.Log events emitted by any watched contract, tagging each with its address. In the
   * current descriptors `address`/`topics` are already hex strings and `data` is a Uint8Array.
   *
   * An `EVM.Log` never names its own transaction, so the hash comes from the `Ethereum.Executed`
   * that follows the logs of each ethereum call — buffer the logs, and assign when it arrives.
   *
   * Not every log has one. The landing's deliveries are XCM-driven `pallet_evm` calls that produce
   * no ethereum transaction at all — they sit in the `Finalization` phase with no `Executed` after
   * them — and those are precisely why this chain is read over substrate rather than eth_getLogs.
   * They keep the block-and-event identity instead, which is the only name they have.
   */
  private extractEvmLogs(records: RawRecord[]): IndexedLog[] {
    const out: IndexedLog[] = [];
    let awaiting: IndexedLog[] = [];

    for (let i = 0; i < records.length; i++) {
      const evt = records[i].event;

      if (evt.type === "Ethereum" && evt.value.type === "Executed") {
        const { transaction_hash, from } = evt.value.value as EthereumExecuted;
        for (const l of awaiting) {
          l.txHash = transaction_hash;
          l.sender = from;
        }
        awaiting = [];
        continue;
      }

      if (evt.type !== "EVM" || evt.value.type !== "Log") continue;
      const { log } = evt.value.value as EvmPayload;
      const address = (log.address as string).toLowerCase();
      if (!this.targets.has(address)) continue;

      const entry: IndexedLog = {
        index: i,
        address,
        topics: log.topics.map((t) => t as `0x${string}`),
        data: bytesToHex(log.data),
      };
      out.push(entry);
      awaiting.push(entry);
    }
    return out;
  }
}

/**
 * Apply a watch's positional topic filter. The node does this for EVM chains; here it is ours to
 * do, and it is what keeps a shared emitter like the Wormhole core down to our own senders.
 *
 * @param w The watch entry.
 * @param topics The log's topics.
 */
function topicsMatch(w: Watch, topics: `0x${string}`[]): boolean {
  if (!w.topics) return true;
  return w.topics.every((want, i) => {
    if (want === null || want === undefined) return true;
    const got = topics[i]?.toLowerCase();
    if (!got) return false;
    return Array.isArray(want)
      ? want.some((x) => x.toLowerCase() === got)
      : want.toLowerCase() === got;
  });
}

/**
 * Reject a read that has not settled within `RPC_TIMEOUT_MS`, so a lost request fails its drain
 * instead of holding it forever.
 *
 * @param p The read.
 * @param what What it reads, for the error.
 * @returns The read's own result.
 */
function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: timed out`)), RPC_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

type RawRecord = {
  event: { type: string; value: { type: string; value: unknown } };
};

/** Frontier's receipt for one ethereum call, emitted after the logs it covers. */
type EthereumExecuted = {
  from: string;
  to: string;
  transaction_hash: string;
};
