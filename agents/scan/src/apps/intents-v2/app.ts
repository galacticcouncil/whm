import { banner } from "../../banner";
import { drainIntervalMs } from "../../config";
import { Drain, serve, subscribe } from "../../flow";
import log from "../../logger";
import { WATCH } from "../../watch";

import { routes } from "./api";
import { orders } from "./flows";

const NAME = "intents-v2";
const FLOWS = [orders];

/**
 * Intents v2: orders published on Hydration and forwarded on Ethereum, and the terms they fund —
 * what the NEAR router bot reads its work from.
 *
 * Reads the event store ingest fills and owns nothing else.
 */
async function main(): Promise<void> {
  banner(NAME);

  const drain = new Drain(NAME, FLOWS, WATCH);
  await drain.initSchema();

  subscribe((u) => {
    const id = u.record.seq as string;
    if (u.kind === "created") log.info(`+ [${u.flow}] ${id} [${u.record.state}]`);
    else if (u.previousState !== u.record.state) {
      log.info(`~ [${u.flow}] ${id} [${u.previousState} -> ${u.record.state}]`);
    }
  });

  await serve({ name: NAME, flows: FLOWS, routes });
  await drain.start(drainIntervalMs);

  log.info("intents-v2 ready.");
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
