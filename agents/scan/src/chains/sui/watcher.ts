import { nearTopic } from "../../abi";
import { applyRewinds, insertEvents, loadCursor, saveCursor, type RawEvent } from "../../db";
import log from "../../logger";
import type { Watch } from "../../types";
import { cursorId } from "../cursor";
import { topicsMatch } from "../events";

import { decode, type Decoded } from "./decode";
import { SuiGraphql } from "./graphql";
import type { SuiChain, Tx } from "./types";

/**
 * Reads Sui through the transactions that touched the NTT managers' shared states — both
 * directions mutate it — decoded by `decode` into the events NEAR-style legs read. The Wormhole
 * core is read through those same transactions (`via`), never on its own.
 */
export class SuiWatcher {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private tip = 0n;
  /** Watch entries by the shared object whose transactions surface them. */
  private readonly sources = new Map<string, Watch[]>();
  /** The NTT states a watch keeps. */
  private readonly states: Set<string>;
  private readonly api: SuiGraphql;

  constructor(
    public readonly cfg: SuiChain,
    private readonly watches: Watch[],
    private readonly onIngest?: (chain: string) => void,
  ) {
    for (const w of watches) {
      for (const a of w.via ?? w.at) this.sources.set(a, [...(this.sources.get(a) ?? []), w]);
    }
    this.states = new Set(watches.filter((w) => !w.via).flatMap((w) => w.at));
    this.api = new SuiGraphql(cfg.graphqlUrl);
  }

  async latestSafe(): Promise<bigint> {
    return this.tip;
  }

  async start(): Promise<void> {
    await this.drain();
    this.timer = setInterval(() => void this.drain(), this.cfg.pollMs);
    log.info(`[${this.cfg.name}] live: manager transactions every ${this.cfg.pollMs}ms`);
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

  /** Each watch's cursor, defaulted to just before its own start checkpoint. */
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
    // Read before the transactions, so whatever landed up to here is in them.
    const head = await this.api.checkpoint();

    const found = new Map<string, { tx: Tx; via: Set<string> }>();
    for (const [object, ws] of this.sources) {
      const after = ws.map((w) => cursors.get(cursorId(w))!).reduce((a, b) => (b < a ? b : a));
      for (const tx of await this.api.transactions(object, after)) {
        // A failed transaction changed nothing — a release not yet due aborts, and is retried.
        if (tx.effects.status !== "SUCCESS") continue;
        const f = found.get(tx.digest) ?? { tx, via: new Set<string>() };
        f.via.add(object);
        found.set(tx.digest, f);
      }
    }

    const ordered = [...found.values()].sort(
      (a, b) => a.tx.effects.checkpoint.sequenceNumber - b.tx.effects.checkpoint.sequenceNumber,
    );
    let ingested = 0;
    for (const { tx, via } of ordered) {
      const n = await insertEvents(
        this.cfg.name,
        this.extract(tx, via, cursors, decode(tx, this.states, nearTopic)),
      );
      if (n > 0) this.onIngest?.(this.cfg.name);
      ingested += n;
    }

    const top = ordered.reduce((m, f) => {
      const cp = BigInt(f.tx.effects.checkpoint.sequenceNumber);
      return cp > m ? cp : m;
    }, head);
    for (const w of this.watches) {
      if (top <= cursors.get(cursorId(w))!) continue;
      await saveCursor(this.cfg.name, cursorId(w), top);
    }
    this.tip = top;
    if (found.size > 0) {
      log.info(`[${this.cfg.name}] ingested ${ingested} events from ${found.size} txs, at ${top}`);
    }
  }

  /**
   * The decoded events the watches that found a transaction keep: under an address a watch keeps,
   * found through that watch's `via`, past its cursor, passing its topic filter.
   *
   * @param tx The transaction.
   * @param via The objects it was found through.
   * @param cursors Each watch's cursor.
   * @param decoded What it did.
   */
  private extract(
    tx: Tx,
    via: Set<string>,
    cursors: Map<string, bigint>,
    decoded: Decoded[],
  ): RawEvent[] {
    const checkpoint = BigInt(tx.effects.checkpoint.sequenceNumber);
    return decoded
      .filter((d) =>
        this.watches.some(
          (w) =>
            w.at.includes(d.address) &&
            cursors.get(cursorId(w))! < checkpoint &&
            (w.via ?? w.at).some((a) => via.has(a)) &&
            topicsMatch(d.topics, w.topics),
        ),
      )
      .map((d) => ({
        txHash: tx.digest,
        logIndex: d.index,
        address: d.address,
        blockNumber: checkpoint,
        blockTimestamp: Date.parse(tx.effects.timestamp),
        topics: d.topics,
        data: JSON.stringify(d.data),
        sender: tx.sender?.address,
      }));
  }
}
