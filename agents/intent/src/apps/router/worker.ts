import log from "../../logger";

import { config } from "./config";
import { balances, deriveAccount, sign, type RouterConfig } from "./near";
import { quote, signedFields, submitIntent } from "./oneclick";
import { plan, type Action } from "./plan";
import { publish } from "./relay";
import { liveTerms, newestOrder, type TermsRow } from "./scan";
import { decodeTerms } from "./terms";
import { loadVaa } from "./wormholescan";

/** A quote outlives the transfer the router signs against it by this much. */
const QUOTE_MARGIN_MS = 5 * 60_000;

/** What the last pass saw for one set of terms — `/api/status`. */
export interface Seen {
  account: string;
  eth: string;
  dest: string;
  action: Action["kind"];
  error?: string;
  at: number;
}

/**
 * Walks every set of terms scan lists, one at a time, and does at most one thing for each. Holds
 * nothing that matters across a restart: the router and `A`'s balances say what is left to do.
 */
export class Worker {
  readonly seen = new Map<string, Seen>();
  /** `A` per `auth_path` — fixed by the path. */
  private readonly accounts = new Map<string, string>();
  /** Orders filled by this process, so one is not re-signed on every pass. */
  private readonly filled = new Set<string>();
  /** Terms finished by this process. */
  private readonly done = new Set<string>();

  constructor(private readonly rc: RouterConfig) {}

  /** One pass over every set of terms in play. */
  async pass(): Promise<void> {
    const since = Math.floor(Date.now() / 1000) - config.graceDays * 86_400;
    for (const row of await liveTerms(since)) {
      if (this.done.has(row.auth_path)) continue;
      try {
        await this.work(row);
      } catch (e) {
        const error = (e as Error).message;
        log.warn(`[${row.auth_path}] ${error}`);
        const s = this.seen.get(row.auth_path);
        if (s) s.error = error;
      }
    }
  }

  /**
   * Read `A`, decide, act.
   *
   * @param row The terms.
   */
  private async work(row: TermsRow): Promise<void> {
    const path = row.auth_path;
    const bytes = Buffer.from(row.terms.replace(/^0x/, ""), "hex");
    const t = decodeTerms(bytes);
    const p = this.rc.params;

    let account = this.accounts.get(path);
    if (!account) {
      account = await deriveAccount(this.rc.mpc_signer, path);
      this.accounts.set(path, account);
    }
    const [eth = 0n, dest = 0n] = await balances(this.rc.intents, account, [this.rc.eth_token, t.destinationAsset]);

    const now = Date.now();
    const priceValidityMs = p.price_validity * 1000;
    const order = eth > 0n && now <= t.deadlineMs ? await newestOrder(path, now - priceValidityMs) : undefined;
    const action = plan({
      nowMs: now,
      deadlineMs: t.deadlineMs,
      maxFillMultiplier: t.maxFillMultiplier,
      minDelivery: t.minDelivery,
      eth,
      dest,
      order: order && {
        seq: order.seq,
        amount: BigInt(order.amount),
        publishedAtMs: order.published.blockTimestamp,
      },
      filled: this.filled,
      priceValidityMs,
      maxOrderShortfallBps: BigInt(p.max_order_shortfall_bps),
      minRefund: BigInt(p.min_refund),
    });
    this.seen.set(path, { account, eth: eth.toString(), dest: dest.toString(), action: action.kind, at: now });

    const terms = bytes.toString("base64");
    switch (action.kind) {
      case "swap": {
        const vaa = await loadVaa(order!.order_vaa);
        const q = await quote({
          account,
          origin: this.rc.eth_token,
          destination: t.destinationAsset,
          amount: action.amount,
          slippageBps: p.min_quote_slippage_bps,
          deadlineMs: now + p.transfer_validity * 1000 + QUOTE_MARGIN_MS,
        });
        const signed = await sign("swap", {
          terms,
          order_vaa: vaa.toString("base64"),
          quote: { signed: signedFields(q), signature: q.signature },
        });
        const s = await submitIntent(signed.signed_data);
        this.filled.add(action.seq);
        log.info(`[${path}] swap order ${action.seq}: ${q.quote.amountIn} wei → ≥ ${q.quote.minAmountOut}, intent ${s.intentHash}`);
        return;
      }
      case "deliver":
      case "refund": {
        const signed = await sign(action.kind, { terms });
        const r = await publish(signed.signed_data);
        log.info(`[${path}] ${action.kind} ${signed.amount} ${signed.token} → ${signed.receiver}: ${r.status}, intent ${r.hash}`);
        return;
      }
      case "drop":
        this.done.add(path);
        log.info(`[${path}] done${eth > 0n ? `, ${eth} wei below min_refund left in ${account}` : ""}`);
        return;
      case "wait":
        return;
    }
  }
}
