import { isAddress } from "viem";

import { createAlerter, Incidents, reprocessPage } from "@whm/common/discord";

import { banner } from "../../banner";
import { CHAINS, ROUTER_CHAINS } from "../../chains";
import log from "../../logger";
import { Deriver } from "../../near/derive";
import { boot, serve } from "../../server";

import { account, provider, redis } from "./clients";
import {
  APP_NAME,
  discordWebhook,
  hydration,
  liveIntervalMs,
  publicUrl,
  redis as redisCfg,
  routes,
  scan,
  stuckMs,
  workIntervalMs,
} from "./config";
import { ScanWatcher, type UtxoPayout } from "./scan";
import { Store } from "./store";
import { HydrationWatcher, type WithdrawRequested } from "./watcher";
import { WithdrawWorker } from "./worker";

/**
 * UTXO withdrawals to the coin's own chain. Watches each route's `WithdrawRequested` on Hydration,
 * and the intents router's deliveries on a UTXO route through scan, and keeps a record per event;
 * withdraws the derived account's balance through the connector once it has arrived — once: a
 * failure is alerted, and waits for a person's reprocess (`/reprocess/:id`). The settlement into
 * that account is `ntt-near`'s (agents/relayer), or the router's payout.
 */
async function start(): Promise<void> {
  banner(APP_NAME);

  const derivers: Record<string, Deriver> = {};
  for (const route of routes) {
    const chain = CHAINS[route.chain];
    if (!chain) throw new Error(`unknown chain ${route.chain}`);
    if (!isAddress(route.emitter) || route.from === 0n) {
      throw new Error(`${route.chain} route is not set — fill it in apps/relayer/config.ts`);
    }
    derivers[chain.name] = await Deriver.create(provider, chain);
    log.info(`  ${chain.name}: ${route.emitter} @ hydration -> ${chain.contract}`);
  }
  for (const chain of Object.values(ROUTER_CHAINS)) {
    derivers[chain.name] ??= await Deriver.create(provider, chain);
    log.info(`  ${chain.name}: intents router -> ${chain.contract}`);
  }
  log.info(`  account: ${account.accountId} (${await account.getBalance()} yocto)`);

  const store = new Store(redis, redisCfg.prefix);

  /**
   * Record one event. A hint only: its account must be what its address derives.
   *
   * @param chain The coin's chain name.
   * @param sequence The record's id within the chain.
   * @param account The account the event names, lowercase hex.
   * @param address The destination address.
   * @param amount What reached the account.
   * @param block Where it happened.
   */
  async function record(
    chain: string,
    sequence: string,
    account: string,
    address: string,
    amount: string,
    block: string,
  ): Promise<void> {
    const id = `${chain}:${sequence}`;
    // An address the withdraw contract rejects derives nothing: its record can never work, and must
    // not hold up the events after it. Any other failure is retried.
    let invalid: string | undefined;
    const derived = await derivers[chain].account(address).catch((e: Error) => {
      if (!e.message.includes("InvalidAddress")) throw e;
      invalid = e.message;
      return null;
    });
    const now = Date.now();
    const added = await store.add({
      chain,
      sequence,
      account,
      address,
      amount,
      block,
      state: derived === account ? "open" : "mismatch",
      createdAt: now,
      updatedAt: now,
      lastError: invalid,
    });
    if (!added) return;
    if (invalid) log.error(`[${id}] ${address} is no valid address — ${amount} stays on ${account}`);
    else if (derived !== account) log.error(`[${id}] ${address} derives ${derived}, event names ${account}`);
    else log.info(`[${id}] ${amount} -> ${address} via ${account}`);
  }

  async function onWithdrawal(w: WithdrawRequested): Promise<void> {
    const account = w.nearAccount.slice(2).toLowerCase();
    const address = w.chain.decode(w.destination);
    await record(w.chain.name, w.sequence.toString(), account, address, w.amount.toString(), w.block.toString());
  }

  /** The chain whose withdraw contract takes a token, by intents ledger id. */
  const chainOfToken = new Map(Object.values(derivers).map((d) => [`nep141:${d.params.token}`, d.chain.name]));

  async function onPayout(p: UtxoPayout): Promise<void> {
    const chain = chainOfToken.get(p.token);
    if (!chain) {
      log.warn(`[intent:${p.id}] no route serves ${p.token}`);
      return;
    }
    await record(chain, `intent:${p.id}`, p.utxo_account.toLowerCase(), p.receiver, p.amount, p.signed_at);
  }

  const watcher = new HydrationWatcher(
    { ...hydration, liveIntervalMs },
    routes.map((route) => ({ route, chain: CHAINS[route.chain] })),
    store,
    onWithdrawal,
  );
  const payouts = new ScanWatcher(scan, store, onPayout);
  const alerter = createAlerter({ webhook: discordWebhook, repeatMs: 6 * 3_600_000, log });
  const incidents = new Incidents({ redis, prefix: redisCfg.prefix, app: `utxo ${APP_NAME}`, alerter, publicUrl, log });
  const worker = new WithdrawWorker({ intervalMs: workIntervalMs, stuckMs }, provider, account, derivers, store, incidents, alerter);

  await serve({
    name: APP_NAME,
    routes: (app) => {
      app.get<{ Params: { id: string }; Querystring: { token?: string } }>("/reprocess/:id", async (req, reply) =>
        reply.type("text/html").send(reprocessPage(`utxo ${APP_NAME}`, req.params.id, req.query.token ?? "")),
      );
      app.post<{ Params: { id: string }; Body: { token?: string } }>("/reprocess/:id", async (req, reply) => {
        const result = await incidents.redeem(req.params.id, String(req.body?.token ?? ""));
        return result === "ok" ? { ok: true } : reply.code(result === "limited" ? 429 : 403).send(result);
      });
    },
    status: async () => ({
      account: account.accountId,
      cursor: (await store.cursor())?.toString() ?? null,
      incidents: await incidents.list(),
      open: (await store.open()).map(({ chain, sequence, account, lastError }) => ({ chain, sequence, account, lastError })),
    }),
  });

  await watcher.start();
  payouts.start();
  worker.start();
}

boot(APP_NAME, start);
