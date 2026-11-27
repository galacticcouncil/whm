import { config } from "./config";

/** One set of terms still in play — scan's `/api/terms`. */
export interface TermsRow {
  auth_path: string;
  /** Encoded terms, `0x` hex. */
  terms: string;
  /** Unix seconds — the earliest a close of these terms lets anyone settle; null while open. */
  settle_at: string | null;
  /** A close VAA id whose countdown has passed — what `settle` takes; null until one has. */
  close_vaa: string | null;
}

/** One order — scan's `/api/orders`, as far as the bot reads it. */
export interface OrderRow {
  seq: string;
  amount: string;
  /** The dispatcher's price when the order was placed — destination units per 1e18 wei. */
  out_per_in: string;
  /** `73/<dispatcher>/<messageSequence>`. */
  order_vaa: string;
  published: { blockTimestamp: number };
  /** When the forwarder paid it into 1Click's deposit address on Ethereum; absent until then. */
  forwarded?: { blockTimestamp: number } | null;
}

/**
 * GET from scan.
 *
 * @param path Endpoint and query.
 * @returns The JSON response.
 * @throws On a non-2xx.
 */
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${config.scanApi}${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`scan ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Terms whose deadline is after `deadlineAfter`.
 *
 * @param deadlineAfter Unix seconds.
 * @returns One row per `auth_path`.
 */
export function liveTerms(deadlineAfter: number): Promise<TermsRow[]> {
  return get(`/api/terms?deadlineAfter=${deadlineAfter}`);
}

/**
 * The newest order of one set of terms, published after `publishedAfterMs`.
 *
 * @param authPath The terms' `auth_path`.
 * @param publishedAfterMs Unix ms.
 * @returns The order, or none.
 */
export async function newestOrder(authPath: string, publishedAfterMs: number): Promise<OrderRow | undefined> {
  const r = await get<{ items: OrderRow[] }>(
    `/api/orders?authPath=${authPath}&publishedAfter=${publishedAfterMs}&limit=1`,
  );
  return r.items[0];
}
