import { isAddress } from "viem";

import { banner } from "../../banner";
import { CHAINS } from "../../chains";
import log from "../../logger";
import { Deriver } from "../../near/derive";
import { boot, serve } from "../../server";

import { account, provider, redis } from "./clients";
import { APP_NAME, hydration, liveIntervalMs, redis as redisCfg, routes, stuckMs, workIntervalMs } from "./config";
import { Store } from "./store";
import { HydrationWatcher, type WithdrawRequested } from "./watcher";
import { WithdrawWorker } from "./worker";

/**
 * UTXO withdrawals, Hydration → the coin's own chain. Watches each route's `WithdrawRequested` and
 * keeps a record per event; retries each until the derived account's balance has gone out through
 * the connector. The settlement into that account is `ntt-near`'s (agents/relayer).
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
  log.info(`  account: ${account.accountId} (${await account.getBalance()} yocto)`);

  const store = new Store(redis, redisCfg.prefix);

  /** Record one event. A hint only: its account must be what its address derives. */
  async function onWithdrawal(w: WithdrawRequested): Promise<void> {
    const id = `${w.chain.name}:${w.sequence}`;
    const account = w.nearAccount.slice(2).toLowerCase();
    const address = w.chain.decode(w.destination);
    const derived = await derivers[w.chain.name].account(address);
    const now = Date.now();

    const added = await store.add({
      chain: w.chain.name,
      sequence: w.sequence.toString(),
      account,
      address,
      amount: w.amount.toString(),
      block: w.block.toString(),
      state: derived === account ? "open" : "mismatch",
      createdAt: now,
      updatedAt: now,
    });
    if (!added) return;
    if (derived !== account) log.error(`[${id}] ${address} derives ${derived}, event names ${account}`);
    else log.info(`[${id}] ${w.amount} -> ${address} via ${account}`);
  }

  const watcher = new HydrationWatcher(
    { ...hydration, liveIntervalMs },
    routes.map((route) => ({ route, chain: CHAINS[route.chain] })),
    store,
    onWithdrawal,
  );
  const worker = new WithdrawWorker({ intervalMs: workIntervalMs, stuckMs }, provider, account, derivers, store);

  await serve({
    name: APP_NAME,
    status: async () => ({
      account: account.accountId,
      cursor: (await store.cursor())?.toString() ?? null,
      open: (await store.open()).map(({ chain, sequence, account, lastError }) => ({ chain, sequence, account, lastError })),
    }),
  });

  await watcher.start();
  worker.start();
}

boot(APP_NAME, start);
