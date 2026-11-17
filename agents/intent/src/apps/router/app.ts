import { banner } from "../../banner";
import log from "../../logger";
import { boot, serve } from "../../server";

import { APP_NAME, config } from "./config";
import { routerConfig } from "./near";
import { Worker } from "./worker";

/**
 * The NEAR side of intents v2. For every set of terms scan lists, reads `A`'s balances and has the
 * router sign what is due — a swap through 1Click, a delivery, a refund — then publishes it. The
 * router checks everything; this only decides when to ask.
 */
async function start(): Promise<void> {
  banner(APP_NAME);
  const rc = await routerConfig();
  log.info(`  router: ${config.router}, bot: ${config.account}, scan: ${config.scanApi}`);
  log.info(`  params: ${JSON.stringify(rc.params)}`);

  const worker = new Worker(rc);
  await serve({
    name: APP_NAME,
    routes: () => {},
    status: () => ({ router: config.router, terms: Object.fromEntries(worker.seen) }),
  });

  for (;;) {
    await worker.pass().catch((e) => log.error(`pass: ${(e as Error).message}`));
    await new Promise((r) => setTimeout(r, config.tickMs));
  }
}

boot(APP_NAME, start);
