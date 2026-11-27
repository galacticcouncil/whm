import { setTimeout as sleep } from "timers/promises";

import type { Incidents, RedisLike } from "@whm/common/discord";

import log from "../../logger";

import { config, SEND_ATTEMPTS, SEND_RETRY_MS } from "./config";
import { balances, deriveAccount, ensureRegistered, execute, sign, signAll, utxoRoutes, type RouterConfig, type Signed } from "./near";
import { quote, signedFields, submitIntent } from "./oneclick";
import { plan, type Action } from "./plan";
import { Refused } from "./types";
import { liveTerms, newestOrder, type TermsRow } from "./scan";
import { decodeTerms, type Terms } from "./terms";
import { delivery, routeFor, type UtxoRoute } from "./utxo";
import { loadVaa } from "./wormholescan";

/** A quote outlives the transfer the router signs against it by this much. */
const QUOTE_MARGIN_MS = 5 * 60_000;

/** One signed payload, and how the log names it. */
interface Payload {
  signed: Signed;
  label: string;
}

/**
 * A delivery, refund or settle payload, named for the log.
 *
 * @param kind The action.
 * @param s The `intent_signed` event's data.
 * @returns The payload.
 */
function payout(kind: string, s: Signed): Payload {
  return { signed: s, label: `${kind} ${s.amount} ${s.token} → ${s.receiver}` };
}

/** What the last pass saw for one set of terms — `/api/status`. */
export interface Seen {
  account: string;
  eth: string;
  dest: string;
  action: Action["kind"];
  error?: string;
  /** The open incident that stops the bot on these terms. */
  stopped?: string;
  at: number;
}

/**
 * Walks every set of terms scan lists, one at a time, and does at most one thing for each — the
 * router and `A`'s balances say what. A signature costs the bot's account before the step that can
 * fail, so the bot tries once: a sign that fails, or a send still failing after a few resends of the
 * same payload, opens an incident and the bot leaves those terms alone until a person reprocesses
 * them. Incidents and filled orders are in Redis, so a restart pays for neither again.
 */
export class Worker {
  readonly seen = new Map<string, Seen>();
  /** `A` per `auth_path` — fixed by the path. */
  private readonly accounts = new Map<string, string>();
  /** Orders swapped, so one is never signed twice — loaded from Redis at `init`. */
  private readonly filled = new Set<string>();
  /** Terms finished by this process. */
  private readonly done = new Set<string>();
  /** The router's UTXO routes, read each pass. */
  private routes: Record<string, UtxoRoute> = {};
  /** `A_utxo` registrations this process has seen, by `token:account`. */
  private readonly registered = new Set<string>();

  constructor(
    private readonly rc: RouterConfig,
    private readonly incidents: Incidents,
    private readonly redis: RedisLike,
  ) {}

  private get filledKey(): string {
    return `${config.redis.prefix}:filled`;
  }

  /** Load the orders already swapped. */
  async init(): Promise<void> {
    for (const seq of await this.redis.smembers(this.filledKey)) this.filled.add(seq);
  }

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

    const incident = await this.incidents.get(path);
    if (incident) {
      this.seen.set(path, { account, eth: eth.toString(), dest: dest.toString(), action: "wait", stopped: incident.reason, at: now });
      return;
    }

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
        const label = `swap order ${action.seq}: ${q.quote.amountIn} wei → ≥ ${q.quote.minAmountOut}`;
        const args = { terms, order_vaa: vaa.toString("base64"), quote: { signed: signedFields(q), signature: q.signature } };
        await this.attempt(path, "swap", async () => [{ signed: await sign("swap", args), label }]);
        this.filled.add(action.seq);
        await this.redis.sadd(this.filledKey, action.seq);
        return;
      }
      case "deliver":
      case "refund":
        return this.attempt(path, action.kind, async () => {
          if (action.kind === "deliver") await this.registerUtxo(path, t);
          return [payout(action.kind, await sign(action.kind, { terms }))];
        });
      case "settle": {
        const vaa = await loadVaa(action.closeVaa);
        return this.attempt(path, "settle", async () => {
          await this.registerUtxo(path, t);
          return (await signAll("settle", { terms, close_vaa: vaa.toString("base64") })).map((s) => payout("settle", s));
        });
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
   * The paid part, once: have the router sign, then send each payload — a swap to 1Click, a payout
   * to the verifier from the bot's account. A send that reached no decision is resent as signed, a
   * few times; any failure past that, or in signing, opens an incident for the terms.
   *
   * @param path The terms' `auth_path`.
   * @param kind The action, for the incident.
   * @param signPayloads Has the router sign — one payload, or a settle's two — and pays for whatever
   *        it needs first.
   * @throws The failure, once its incident is open.
   */
  private async attempt(path: string, kind: Action["kind"], signPayloads: () => Promise<Payload[]>): Promise<void> {
    let step = `${kind}: sign`;
    try {
      for (const { signed, label } of await signPayloads()) {
        step = label;
        const ref = await resend(() =>
          kind === "swap"
            ? submitIntent(signed.signed_data).then((s) => `intent ${s.intentHash}`)
            : execute(this.rc.intents, signed.signed_data).then((tx) => `tx ${tx}`),
        );
        log.info(`[${path}] ${label}: ${ref}`);
      }
    } catch (e) {
      await this.incidents.open(path, `${step} — ${(e as Error).message}`);
      const s = this.seen.get(path);
      if (s) s.stopped = (e as Error).message;
      throw e;
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

/**
 * Send, and resend the same thing while it reaches no decision. A refusal is final at once.
 *
 * @param send The send.
 * @returns Its result.
 * @throws A refusal, or the last failure.
 */
async function resend<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (e) {
      if (e instanceof Refused || attempt >= SEND_ATTEMPTS) throw e;
      log.warn(`send failed (${(e as Error).message}), resending as signed`);
      await sleep(SEND_RETRY_MS);
    }
  }
}
