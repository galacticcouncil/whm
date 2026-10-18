import { nearTopic } from "../../abi";
import { applyRewinds, insertEvents, loadCursor, saveCursor, type RawEvent } from "../../db";
import log from "../../logger";
import type { Watch } from "../../types";
import { cursorId } from "../cursor";

import { TX_BATCH } from "./consts";
import { FastNear, nearLogs } from "./fastnear";
import type { NearChain, Tx } from "./types";

/** A transaction found in the history, and the accounts whose history it was found in. */
interface Found {
  height: bigint;
  via: Set<string>;
}

/**
 * Reads NEAR through FastNEAR's transaction index: the history of the accounts we own, then those
 * transactions whole, receipts and logs included.
 *
 * NEAR has no log filter, and a shared contract's own history is everyone's — the connector alone
 * has hundreds of thousands of transactions. So a contract is read through the accounts of ours
 * that touch it (`via`), and only the events its receipts log inside those transactions are kept.
 *
 * A NEP-297 log is stored like an EVM log: `topic0` is `keccak256("<standard>:<event>")` and the
 * data is the event's JSON, one row per element of its `data` array. A call named in `calls` is
 * stored the same way, under the standard `call`, carrying its arguments.
 */
export class NearWatcher {
  private timer?: NodeJS.Timeout;
  private busy = false;
  /** The highest block the index has shown us — NEAR's stand-in for a safe head. */
  private tip = 0n;
  /** Watch entries by the account whose history surfaces them. */
  private readonly sources = new Map<string, Watch[]>();
  private readonly api: FastNear;
  /** Every method any entry keeps calls to. */
  private readonly calls: Set<string>;

  constructor(
    public readonly cfg: NearChain,
    private readonly watches: Watch[],
    private readonly onIngest?: (chain: string) => void,
  ) {
    for (const w of watches) {
      for (const a of w.via ?? w.at) this.sources.set(a, [...(this.sources.get(a) ?? []), w]);
    }
    this.api = new FastNear(cfg.txApi);
    this.calls = new Set(watches.flatMap((w) => w.calls ?? []));
  }

  async latestSafe(): Promise<bigint> {
    return this.tip;
  }

  async start(): Promise<void> {
    await this.drain();
    this.timer = setInterval(() => void this.drain(), this.cfg.pollMs);
    log.info(`[${this.cfg.name}] live: account histories every ${this.cfg.pollMs}ms`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.tick();
    } catch (e) {
      log.error(`[${this.cfg.name}] drain: ${(e as Error).stack ?? String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  /** Each watch's cursor, defaulted to just before its own start block. */
  private async cursors(): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    for (const w of this.watches) {
      out.set(cursorId(w), (await loadCursor(this.cfg.name, cursorId(w))) ?? w.from - 1n);
    }
    return out;
  }

  private async tick(): Promise<void> {
    await applyRewinds(this.cfg.name, this.watches.map(cursorId));
    const cursors = await this.cursors();

    const found = new Map<string, Found>();
    for (const [account, ws] of this.sources) {
      const after = ws.map((w) => cursors.get(cursorId(w))!).reduce((a, b) => (b < a ? b : a));
      for (const r of await this.api.history(account, after)) {
        const f = found.get(r.transaction_hash) ?? {
          height: BigInt(r.tx_block_height),
          via: new Set<string>(),
        };
        f.via.add(account);
        found.set(r.transaction_hash, f);
      }
    }
    if (found.size === 0) return;

    const ordered = [...found].sort(([ha, a], [hb, b]) =>
      a.height === b.height ? ha.localeCompare(hb) : a.height < b.height ? -1 : 1,
    );
    const top = ordered[ordered.length - 1][1].height;

    let ingested = 0;
    const step = TX_BATCH * this.cfg.concurrency;
    for (let i = 0; i < ordered.length; i += step) {
      const slices: string[][] = [];
      for (let j = i; j < Math.min(i + step, ordered.length); j += TX_BATCH) {
        slices.push(ordered.slice(j, Math.min(j + TX_BATCH, i + step)).map(([h]) => h));
      }
      const fetched = new Map(
        (await Promise.all(slices.map((s) => this.api.transactions(s))))
          .flat()
          .map((t) => [t.transaction.hash, t]),
      );
      // In history order, so `seq` follows the chain as closely as one transaction at a time can.
      for (const hashes of slices) {
        for (const h of hashes) {
          const n = await insertEvents(
            this.cfg.name,
            this.extract(fetched.get(h)!, found.get(h)!, cursors),
          );
          if (n > 0) this.onIngest?.(this.cfg.name);
          ingested += n;
        }
      }
    }

    for (const w of this.watches) {
      if (top <= cursors.get(cursorId(w))!) continue;
      await saveCursor(this.cfg.name, cursorId(w), top);
    }
    if (top > this.tip) this.tip = top;
    log.info(`[${this.cfg.name}] ingested ${ingested} events from ${found.size} txs, at ${top}`);
  }

  /**
   * The events a transaction carries for the watches that found it: logged or called by a contract
   * a watch keeps, in a transaction found through that watch's `via`, at a block past its cursor.
   *
   * @param tx The transaction, whole.
   * @param f Where it was found.
   * @param cursors Each watch's cursor.
   */
  private extract(tx: Tx, f: Found, cursors: Map<string, bigint>): RawEvent[] {
    return nearLogs(tx, this.calls)
      .filter((l) =>
        this.watches.some(
          (w) =>
            w.at.includes(l.executor) &&
            cursors.get(cursorId(w))! < f.height &&
            (w.via ?? w.at).some((a) => f.via.has(a)) &&
            (l.standard !== "call" || (w.calls ?? []).includes(l.event)),
        ),
      )
      .map((l) => ({
        txHash: tx.transaction.hash,
        logIndex: l.index,
        address: l.executor,
        blockNumber: BigInt(l.blockHeight),
        blockTimestamp: l.blockTimestamp,
        topics: [nearTopic(l)],
        data: JSON.stringify(l.data),
        sender: l.predecessor,
      }));
  }
}
