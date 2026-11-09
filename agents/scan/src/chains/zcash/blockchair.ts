import { BLOCKCHAIR, BLOCKCHAIR_BATCH } from "./consts";

/** Where a transaction landed. */
export interface Inclusion {
  block: number;
  /** Unix ms. */
  blockTimestamp: number;
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The block each transaction is in, for those that are in one. One request per `BLOCKCHAIR_BATCH`
 * transactions; a transaction still in the mempool, or unknown, is simply absent.
 *
 * @param txids Transaction ids, hex.
 */
export async function inclusions(txids: string[]): Promise<Map<string, Inclusion>> {
  const out = new Map<string, Inclusion>();
  for (let i = 0; i < txids.length; i += BLOCKCHAIR_BATCH) {
    const slice = txids.slice(i, i + BLOCKCHAIR_BATCH);
    const res = await fetch(`${BLOCKCHAIR}/dashboards/transactions/${slice.join(",")}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`blockchair: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      data?: Record<string, { transaction?: { block_id: number; time: string } }>;
    };
    for (const [txid, d] of Object.entries(body.data ?? {})) {
      const t = d?.transaction;
      if (!t || t.block_id < 0) continue;
      out.set(txid, {
        block: t.block_id,
        blockTimestamp: Date.parse(`${t.time.replace(" ", "T")}Z`),
      });
    }
  }
  return out;
}
