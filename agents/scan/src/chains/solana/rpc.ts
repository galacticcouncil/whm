import { ACCOUNT_BATCH, SIGNATURE_PAGE } from "./consts";
import type { SignatureRow, Tx } from "./types";

const REQUEST_TIMEOUT_MS = 30_000;
/** A rate-limited request is retried this many times, backing off from one second. */
const RETRIES = 5;

/**
 * The handful of Solana RPC methods the watcher needs, all at `finalized` — a finalized slot is
 * never rolled back, so nothing read here is ever unread.
 */
export class SolanaRpc {
  private id = 0;

  /**
   * @param url JSON-RPC endpoint.
   */
  constructor(private readonly url: string) {}

  /** The latest finalized slot. */
  async slot(): Promise<bigint> {
    return BigInt(await this.call<number>("getSlot", [{ commitment: "finalized" }]));
  }

  /**
   * An address's signatures above `after`, newest first, across as many pages as that takes.
   *
   * @param address A program or account.
   * @param after Exclusive lower bound, a slot.
   */
  async signatures(address: string, after: bigint): Promise<SignatureRow[]> {
    const out: SignatureRow[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.call<SignatureRow[]>("getSignaturesForAddress", [
        address,
        { limit: SIGNATURE_PAGE, commitment: "finalized", ...(before && { before }) },
      ]);
      for (const r of page) {
        if (BigInt(r.slot) <= after) return out;
        out.push(r);
      }
      if (page.length < SIGNATURE_PAGE) return out;
      before = page[page.length - 1].signature;
    }
  }

  /**
   * A transaction whole. Throws when it is missing, so nothing is stepped over for want of it.
   *
   * @param signature Its first signature.
   */
  async transaction(signature: string): Promise<Tx> {
    const tx = await this.call<Tx | null>("getTransaction", [
      signature,
      { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 },
    ]);
    if (!tx) throw new Error(`getTransaction: ${signature} not found`);
    return tx;
  }

  /**
   * Accounts' data, by address; a closed account is absent.
   *
   * @param addresses Any number.
   */
  async accounts(addresses: string[]): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    for (let i = 0; i < addresses.length; i += ACCOUNT_BATCH) {
      const slice = addresses.slice(i, i + ACCOUNT_BATCH);
      const r = await this.call<{ value: ({ data: [string, string] } | null)[] }>(
        "getMultipleAccounts",
        [slice, { encoding: "base64", commitment: "finalized" }],
      );
      r.value.forEach((a, j) => {
        if (a) out.set(slice[j], Buffer.from(a.data[0], "base64"));
      });
    }
    return out;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 429 && attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`${method}: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { result?: T; error?: { message: string } };
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result as T;
    }
  }
}
