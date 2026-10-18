import { nearTopic } from "../abi";
import log from "../logger";
import { applyRewinds, insertEvents, loadCursor, saveCursor, type RawEvent } from "../db";
import type { NearChain, Watch } from "../types";

import { cursorId } from "./cursor";

/** FastNEAR's page size for an account's history, and its cap on transactions per request. */
const PAGE = 200;
const TX_BATCH = 20;

const REQUEST_TIMEOUT_MS = 30_000;

/** Slots per receipt in a transaction's log index: the receipt's position × this + the event's. */
const PER_RECEIPT = 1_000;

interface HistoryRow {
  transaction_hash: string;
  tx_block_height: number;
}

interface Outcome {
  block_height: number;
  /** Nanoseconds. */
  block_timestamp: number;
  index: number;
  outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> };
}

interface Action {
  FunctionCall?: { method_name: string; args: string };
}

interface Tx {
  transaction: { hash: string };
  receipts: {
    receipt: { predecessor_id: string; receipt: { Action?: { actions: (Action | string)[] } } };
    execution_outcome: Outcome;
  }[];
}

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

  constructor(
    public readonly cfg: NearChain,
    private readonly watches: Watch[],
    private readonly onIngest?: (chain: string) => void,
  ) {
    for (const w of watches) {
      for (const a of w.via ?? w.at) this.sources.set(a, [...(this.sources.get(a) ?? []), w]);
    }
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
      for (const r of await this.history(account, after)) {
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
        (await Promise.all(slices.map((s) => this.transactions(s))))
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
   * The events a transaction carries for the watches that found it, in receipt order.
   *
   * A failed receipt's logs never happened — its state was rolled back — so they are skipped. Log
   * indexes are slotted by receipt position rather than counted over what is kept, so a watch
   * added later re-reads the same transaction into the same keys.
   *
   * @param tx The transaction, whole.
   * @param f Where it was found.
   * @param cursors Each watch's cursor — a watch already past this block keeps nothing.
   */
  private extract(tx: Tx, f: Found, cursors: Map<string, bigint>): RawEvent[] {
    const out: RawEvent[] = [];
    const receipts = [...tx.receipts].sort((a, b) =>
      a.execution_outcome.block_height === b.execution_outcome.block_height
        ? a.execution_outcome.index - b.execution_outcome.index
        : a.execution_outcome.block_height - b.execution_outcome.block_height,
    );

    receipts.forEach((r, position) => {
      const { block_height, block_timestamp, outcome } = r.execution_outcome;
      if ("Failure" in outcome.status) return;
      const ws = this.watches.filter(
        (w) =>
          w.at.includes(outcome.executor_id) &&
          cursors.get(cursorId(w))! < f.height &&
          (w.via ?? w.at).some((a) => f.via.has(a)),
      );
      if (ws.length === 0) return;

      let slot = position * PER_RECEIPT;
      const push = (standard: string, event: string, data: unknown) =>
        out.push({
          txHash: tx.transaction.hash,
          logIndex: slot++,
          address: outcome.executor_id,
          blockNumber: BigInt(block_height),
          blockTimestamp: Math.floor(block_timestamp / 1e6),
          topics: [nearTopic({ standard, event })],
          data: JSON.stringify(data),
          sender: r.receipt.predecessor_id,
        });

      const calls = new Set(ws.flatMap((w) => w.calls ?? []));
      for (const a of r.receipt.receipt.Action?.actions ?? []) {
        const call = typeof a === "string" ? undefined : a.FunctionCall;
        if (!call || !calls.has(call.method_name)) continue;
        const args = parseArgs(call.args);
        if (args !== null) push("call", call.method_name, args);
      }

      for (const line of outcome.logs) {
        const e = parseEvent(line);
        if (!e) continue;
        const { standard, event, data, version: _version, ...rest } = e;
        // NEP-297 carries a list; Wormhole's core logs one flat object with the payload as `data`.
        for (const item of Array.isArray(data) ? data : [{ data, ...rest }])
          push(standard, event, item);
      }
    });
    return out;
  }

  /**
   * An account's transactions above `after`, newest first, across as many pages as that takes.
   *
   * @param account The account.
   * @param after Exclusive lower bound.
   */
  private async history(account: string, after: bigint): Promise<HistoryRow[]> {
    const out: HistoryRow[] = [];
    let max: number | undefined;
    for (;;) {
      const page = await this.post<{ account_txs?: HistoryRow[] }>("/v0/account", {
        account_id: account,
        ...(max !== undefined && { max_block_height: max }),
      });
      const rows = page.account_txs ?? [];
      for (const r of rows) {
        if (BigInt(r.tx_block_height) <= after) return out;
        out.push(r);
      }
      if (rows.length < PAGE) return out;
      // Inclusive bound, so the boundary block is read twice and deduplicated by hash; a page that
      // is one block throughout steps past it rather than looping.
      const last = rows[rows.length - 1].tx_block_height;
      max = last === max ? last - 1 : last;
    }
  }

  /**
   * Transactions whole. Throws when one is missing, so the cursor never steps over it.
   *
   * @param hashes At most `TX_BATCH`.
   */
  private async transactions(hashes: string[]): Promise<Tx[]> {
    const r = await this.post<{ transactions?: (Tx | null)[] }>("/v0/transactions", {
      tx_hashes: hashes,
    });
    const txs = (r.transactions ?? []).filter((t): t is Tx => t !== null);
    if (txs.length !== hashes.length) {
      throw new Error(`transactions: asked for ${hashes.length}, got ${txs.length}`);
    }
    return txs;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.txApi}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
}

/**
 * A NEP-297 log line, or null for anything else a contract logs.
 *
 * @param line One log line.
 */
function parseEvent(
  line: string,
): ({ standard: string; event: string; data?: unknown } & Record<string, unknown>) | null {
  if (!line.startsWith("EVENT_JSON:")) return null;
  try {
    const e = JSON.parse(line.slice("EVENT_JSON:".length));
    return typeof e?.standard === "string" && typeof e?.event === "string" ? e : null;
  } catch {
    return null;
  }
}

/**
 * A call's arguments, base64 JSON as NEAR carries them, or null when they are not JSON.
 *
 * @param base64 The action's `args`.
 */
function parseArgs(base64: string): unknown {
  try {
    return JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}
