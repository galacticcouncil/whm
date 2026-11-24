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

/** One payment into an address. */
export interface Payment {
  hash: string;
  /** Unix ms. */
  at: number;
  /** Received, in the chain's base unit — zatoshi, satoshi. */
  amount: bigint;
}

/**
 * The payments into a transparent address, from its latest hundred transactions, oldest first. A
 * shielded address shows nothing to an explorer.
 *
 * @param address The address.
 * @param api Blockchair's API for the chain — Zcash's by default; its Bitcoin API has the same shape.
 */
export async function payments(address: string, api = BLOCKCHAIR): Promise<Payment[]> {
  const res = await fetch(`${api}/dashboards/address/${address}?transaction_details=true&limit=100`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`blockchair ${address}: ${res.status}`);
  const body = (await res.json()) as {
    data?: Record<string, { transactions?: { hash: string; time: string; balance_change: number }[] }>;
  };
  return (body.data?.[address]?.transactions ?? [])
    .filter((t) => t.balance_change > 0)
    .map((t) => ({ hash: t.hash, at: Date.parse(`${t.time.replace(" ", "T")}Z`), amount: BigInt(t.balance_change) }))
    .sort((a, b) => a.at - b.at);
}
