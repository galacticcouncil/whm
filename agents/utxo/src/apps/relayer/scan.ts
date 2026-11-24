import log from "../../logger";

import type { Store } from "./store";

/** One router delivery to `A_utxo` — scan's `/api/payouts?utxo=true`. */
export interface UtxoPayout {
  id: string;
  auth_path: string;
  amount: string;
  /** Intents ledger id, e.g. `nep141:zec.omft.near`. */
  token: string;
  /** The address on the coin's chain. */
  receiver: string;
  /** `A_utxo`. */
  utxo_account: string;
  /** Unix ms. */
  signed_at: string;
}

const PAGE = 500;

/**
 * The intents router's deliveries on a UTXO route, as scan indexes them: each lands on the `A_utxo`
 * its address derives, like a `WithdrawRequested` settlement, and is withdrawn the same way. Polls
 * from a Redis cursor; scan's page is inclusive of the cursor's millisecond, and the store keeps the
 * first record of an id.
 */
export class ScanWatcher {
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly cfg: { apiUrl: string; intervalMs: number },
    private readonly store: Store,
    private readonly onPayout: (p: UtxoPayout) => Promise<void>,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.poll(), this.cfg.intervalMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const after = (await this.store.scanCursor()) ?? 0;
        const page = await this.page(after);
        for (const p of page) await this.onPayout(p);
        const last = Number(page.at(-1)?.signed_at ?? after);
        await this.store.saveScanCursor(last);
        // A full page that did not move the cursor is one millisecond's worth; the next can't either.
        if (page.length < PAGE || last === after) break;
      }
    } catch (e) {
      log.warn(`[scan] ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * @param after Unix ms, inclusive.
   * @returns Scan's deliveries from it, oldest first.
   */
  private async page(after: number): Promise<UtxoPayout[]> {
    const url = `${this.cfg.apiUrl}/api/payouts?utxo=true&after=${after}&limit=${PAGE}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return (await res.json()) as UtxoPayout[];
  }
}
