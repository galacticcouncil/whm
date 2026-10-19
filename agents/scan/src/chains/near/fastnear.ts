import { HISTORY_PAGE, PER_RECEIPT, TX_BATCH } from "./consts";
import type { HistoryRow, NearLog, Tx } from "./types";

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * FastNEAR's transaction index: an account's history, and transactions whole — receipts, outcomes
 * and logs. The one way into NEAR here; the watcher and any poller read it alike.
 */
export class FastNear {
  /**
   * @param txApi Base url, e.g. https://tx.main.fastnear.com.
   */
  constructor(private readonly txApi: string) {}

  /**
   * An account's transactions above `after`, newest first, across as many pages as that takes.
   *
   * @param account The account.
   * @param after Exclusive lower bound.
   */
  async history(account: string, after = 0n): Promise<HistoryRow[]> {
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
      if (rows.length < HISTORY_PAGE) return out;
      // Inclusive bound, so the boundary block is read twice and deduplicated by hash; a page that
      // is one block throughout steps past it rather than looping.
      const last = rows[rows.length - 1].tx_block_height;
      max = last === max ? last - 1 : last;
    }
  }

  /**
   * Transactions whole, in batches of `TX_BATCH`, one per hash. Throws when one is missing, so
   * nothing is stepped over for want of it.
   *
   * The index can hold a transaction twice — a stale copy short of its last receipts beside the
   * whole one — so of the copies, the one with the most receipts is kept: a transaction's receipts
   * only grow as it executes.
   *
   * @param hashes Any number.
   */
  async transactions(hashes: string[]): Promise<Tx[]> {
    const out: Tx[] = [];
    for (let i = 0; i < hashes.length; i += TX_BATCH) {
      const slice = hashes.slice(i, i + TX_BATCH);
      const r = await this.post<{ transactions?: (Tx | null)[] }>("/v0/transactions", {
        tx_hashes: slice,
      });
      const whole = new Map<string, Tx>();
      for (const t of r.transactions ?? []) {
        if (!t) continue;
        const seen = whole.get(t.transaction.hash);
        if (!seen || t.receipts.length > seen.receipts.length) whole.set(t.transaction.hash, t);
      }
      const missing = slice.filter((h) => !whole.has(h));
      if (missing.length) {
        throw new Error(
          `transactions: ${missing.length} of ${slice.length} missing (${missing[0]})`,
        );
      }
      out.push(...slice.map((h) => whole.get(h)!));
    }
    return out;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.txApi}${path}`, {
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
 * Every event a transaction's successful receipts logged, in receipt order — plus, for the methods
 * named, the calls themselves with their arguments.
 *
 * A failed receipt's logs never happened — its state was rolled back — so they are skipped. Indexes
 * are slotted by receipt position rather than counted over what is kept, so a reader that keeps
 * more later keys the same events the same way.
 *
 * A NEP-297 log carries a list, and yields one entry per element; Wormhole's core logs one flat
 * object with the payload as `data`, and yields that object.
 *
 * @param tx The transaction, whole.
 * @param calls Methods whose calls to keep as events.
 */
export function nearLogs(tx: Tx, calls: ReadonlySet<string> = new Set()): NearLog[] {
  const out: NearLog[] = [];
  const receipts = [...tx.receipts].sort((a, b) =>
    a.execution_outcome.block_height === b.execution_outcome.block_height
      ? a.execution_outcome.index - b.execution_outcome.index
      : a.execution_outcome.block_height - b.execution_outcome.block_height,
  );

  receipts.forEach((r, position) => {
    const { block_height, block_timestamp, outcome } = r.execution_outcome;
    if ("Failure" in outcome.status) return;

    let slot = position * PER_RECEIPT;
    const push = (standard: string, event: string, data: unknown) =>
      out.push({
        standard,
        event,
        data,
        executor: outcome.executor_id,
        predecessor: r.receipt.predecessor_id,
        index: slot++,
        blockHeight: block_height,
        blockTimestamp: Math.floor(block_timestamp / 1e6),
      });

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
      for (const item of Array.isArray(data) ? data : [{ data, ...rest }]) {
        push(standard, event, item);
      }
    }
  });
  return out;
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
