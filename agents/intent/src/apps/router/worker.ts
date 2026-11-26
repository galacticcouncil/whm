import log from "../../logger";

import { config } from "./config";
import { balances, deriveAccount, ensureRegistered, execute, sign, signAll, utxoRoutes, type RouterConfig, type Signed } from "./near";
import { quote, signedFields, submitIntent } from "./oneclick";
import { balanceKey, Refused, step, type Parked, type Payload, type Pending } from "./once";
import { plan, type Action } from "./plan";
import { liveTerms, newestOrder, type TermsRow } from "./scan";
import { decodeTerms, type Terms } from "./terms";
import { delivery, routeFor, type UtxoRoute } from "./utxo";
import { loadVaa } from "./wormholescan";

/** A quote outlives the transfer the router signs against it by this much. */
const QUOTE_MARGIN_MS = 5 * 60_000;

/** A signed payload is treated as expired this long before the router's deadline for it. */
const EXPIRY_MARGIN_MS = 10_000;

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
  /** Why the bot stopped signing for these terms. */
  parked?: string;
  at: number;
}

/**
 * Walks every set of terms scan lists, one at a time, and does at most one thing for each. The router
 * and `A`'s balances say what is left to do; what the bot keeps is only what spares its account a
 * signature — a payload signed and not yet executed is resent, never signed again, and terms whose
 * payload was refused or expired are parked until `A`'s balances move. A restart forgets both: at
 * most one more signature per parked set of terms.
 */
export class Worker {
  readonly seen = new Map<string, Seen>();
  /** Signed and not yet executed, by `auth_path`. */
  private readonly pending = new Map<string, Pending>();
  /** No more signing, by `auth_path`. */
  private readonly parked = new Map<string, Parked>();
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
    const held = balanceKey(eth, dest);
    const now = Date.now();

    const parked = this.parked.get(path);
    if (parked?.balances === held) {
      this.seen.set(path, { account, eth: eth.toString(), dest: dest.toString(), action: "wait", parked: parked.reason, at: now });
      return;
    }
    if (parked) {
      this.parked.delete(path);
      log.info(`[${path}] unparked: A's balances moved`);
    }

    const pending = this.pending.get(path);
    if (pending) {
      const next = step(pending, now, held);
      if (next === "resend") return this.send(path, pending);
      this.pending.delete(path);
      if (next === "park") return this.park(path, held, `${pending.kind} expired unexecuted`);
      if (pending.seq) this.filled.add(pending.seq);
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
    const validity = p.transfer_validity * 1000;
    switch (action.kind) {
      case "swap": {
        const vaa = await loadVaa(order!.order_vaa);
        const q = await quote({
          account,
          origin: this.rc.eth_token,
          destination: t.destinationAsset,
          amount: action.amount,
          slippageBps: p.min_quote_slippage_bps,
          deadlineMs: now + validity + QUOTE_MARGIN_MS,
        });
        const label = `swap order ${action.seq}: ${q.quote.amountIn} wei → ≥ ${q.quote.minAmountOut}`;
        const args = { terms, order_vaa: vaa.toString("base64"), quote: { signed: signedFields(q), signature: q.signature } };
        return this.signOnce(path, held, { kind: "swap", seq: action.seq }, validity, async () => [{ signed: await sign("swap", args), label }]);
      }
      case "deliver":
      case "refund": {
        if (action.kind === "deliver") await this.registerUtxo(path, t);
        return this.signOnce(path, held, { kind: action.kind }, validity, async () => [payout(action.kind, await sign(action.kind, { terms }))]);
      }
      case "settle": {
        await this.registerUtxo(path, t);
        const vaa = await loadVaa(action.closeVaa);
        return this.signOnce(path, held, { kind: "settle" }, validity, async () =>
          (await signAll("settle", { terms, close_vaa: vaa.toString("base64") })).map((s) => payout("settle", s)),
        );
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
   * Have the router sign, once, and send what it signed. A refusal parks the terms, so a router
   * that will not sign them is not asked again on every pass.
   *
   * @param path The terms' `auth_path`.
   * @param held `A`'s balances now, from `balanceKey`.
   * @param head The action, and a swap's order.
   * @param validityMs How long the router's signature holds — `transfer_validity`.
   * @param signPayloads Has the router sign; one payload, or a settle's two.
   */
  private async signOnce(
    path: string,
    held: string,
    head: Pick<Pending, "kind" | "seq">,
    validityMs: number,
    signPayloads: () => Promise<Payload[]>,
  ): Promise<void> {
    const signedAt = Date.now();
    let payloads: Payload[];
    try {
      payloads = await signPayloads();
    } catch (e) {
      if (e instanceof Refused) return this.park(path, held, e.message);
      throw e;
    }
    const p: Pending = { ...head, payloads, expiresAt: signedAt + validityMs - EXPIRY_MARGIN_MS, balances: held };
    this.pending.set(path, p);
    return this.send(path, p);
  }

  /**
   * Send what is pending, as signed: a swap to 1Click, a payout to the verifier from the bot's account.
   * A send that never reached a decision throws, and the next pass resends; a refusal parks the terms.
   *
   * @param path The terms' `auth_path`.
   * @param p What the router signed for them.
   */
  private async send(path: string, p: Pending): Promise<void> {
    try {
      while (p.payloads.length) {
        const { signed, label } = p.payloads[0];
        const ref =
          p.kind === "swap"
            ? `intent ${(await submitIntent(signed.signed_data)).intentHash}`
            : `tx ${await execute(this.rc.intents, signed.signed_data)}`;
        p.payloads.shift();
        log.info(`[${path}] ${label}: ${ref}`);
      }
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      this.pending.delete(path);
      return this.park(path, p.balances, e.message);
    }
    this.pending.delete(path);
    if (p.seq) this.filled.add(p.seq);
  }

  /**
   * Stop signing for a set of terms until `A`'s balances move — `/api/status` shows why.
   *
   * @param path The terms' `auth_path`.
   * @param balances `A`'s balances it parks at.
   * @param reason Why.
   */
  private park(path: string, balances: string, reason: string): void {
    this.parked.set(path, { balances, reason });
    const s = this.seen.get(path);
    if (s) s.parked = reason;
    log.error(`[${path}] parked — no signing until A's balances move or a restart: ${reason}`);
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
