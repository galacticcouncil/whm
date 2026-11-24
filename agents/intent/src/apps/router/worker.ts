import log from "../../logger";

import { config } from "./config";
import { balances, deriveAccount, ensureRegistered, sign, signAll, utxoRoutes, type RouterConfig } from "./near";
import { quote, signedFields, submitIntent } from "./oneclick";
import { plan, type Action } from "./plan";
import { publish } from "./relay";
import { liveTerms, newestOrder, type TermsRow } from "./scan";
import { decodeTerms, type Terms } from "./terms";
import { delivery, routeFor, type UtxoRoute } from "./utxo";
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
  /** The router's UTXO routes, read each pass. */
  private routes: Record<string, UtxoRoute> = {};
  /** `A_utxo` registrations this process has seen, by `token:account`. */
  private readonly registered = new Set<string>();

  constructor(private readonly rc: RouterConfig) {}

  /** One pass over every set of terms in play. */
  async pass(): Promise<void> {
    const since = Math.floor(Date.now() / 1000) - config.graceDays * 86_400;
    this.routes = await utxoRoutes();
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
      ...delivery(t, this.routes),
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
      settleAtMs: row.settle_at ? Number(row.settle_at) * 1000 : undefined,
      closeVaa: row.close_vaa ?? undefined,
      graceMs: config.graceDays * 86_400_000,
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
        if (action.kind === "deliver") await this.registerUtxo(path, t);
        const signed = await sign(action.kind, { terms });
        const r = await publish(signed.signed_data);
        log.info(`[${path}] ${action.kind} ${signed.amount} ${signed.token} → ${signed.receiver}: ${r.status}, intent ${r.hash}`);
        return;
      }
      case "settle": {
        await this.registerUtxo(path, t);
        const vaa = await loadVaa(action.closeVaa);
        for (const signed of await signAll("settle", { terms, close_vaa: vaa.toString("base64") })) {
          const r = await publish(signed.signed_data);
          log.info(`[${path}] settle ${signed.amount} ${signed.token} → ${signed.receiver}: ${r.status}, intent ${r.hash}`);
        }
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

  /**
   * Before a delivery the router sends to `A_utxo`, register `A_utxo` on the token — unregistered,
   * the withdrawal fails and `intents.near` credits `A` back.
   *
   * @param path The terms' `auth_path`, for the log.
   * @param t The terms.
   */
  private async registerUtxo(path: string, t: Terms): Promise<void> {
    const route = routeFor(t, this.routes);
    if (!route) return;
    const token = t.destinationAsset.replace(/^nep141:/, "");
    const account = await deriveAccount(this.rc.mpc_signer, `${route.path_prefix}${t.recipient}`, route.withdraw);
    const id = `${token}:${account}`;
    if (this.registered.has(id)) return;
    if (await ensureRegistered(token, account)) log.info(`[${path}] registered ${account} on ${token}`);
    this.registered.add(id);
  }
}
