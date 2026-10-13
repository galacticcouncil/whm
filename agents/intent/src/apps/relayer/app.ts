import { banner } from "../../banner";
import log from "../../logger";
import { boot, serve } from "../../server";

import { client } from "./clients";
import { APP_NAME, source } from "./config";
import { routes } from "./routes";
import { IntentWatcher } from "./watcher";

/**
 * The off-chain leg of an intent. `IntentReceiver.processOrder` forwards native ETH to a 1Click
 * deposit address, and 1Click only acts once it knows the deposit landed — so this watches
 * `OrderProcessed` and tells it, rather than waiting for 1Click to notice on its own.
 */
async function start(): Promise<void> {
  banner(APP_NAME);
  log.info(`  receiver: ${source.name} @ ${source.receiver}`);

  const watcher = new IntentWatcher({ name: source.name, receiver: source.receiver }, client);

  await serve({
    name: APP_NAME,
    routes,
    status: () => ({
      chain: source.name,
      receiver: source.receiver,
      processed: watcher.processed,
    }),
  });

  watcher.start();
}

boot(APP_NAME, start);
