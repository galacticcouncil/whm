import { banner } from "../../banner";
import { drainIntervalMs } from "../../config";
import { Drain, serve, subscribe } from "../../flow";
import log from "../../logger";
import { WATCH } from "../../watch";

import { routes } from "./api";
import { intents, orders, payouts } from "./flows";
import { PayoutPoller } from "./payouts";

const NAME = "intents-v2";
const FLOWS = [orders, payouts, intents];

/**
 * Intents v2: orders published on Hydration, forwarded on Ethereum and swapped on NEAR, the payouts
 * of the terms they fund, and the terms themselves — what the NEAR router bot reads its work from.
 *
 * Reads the event store ingest fills — the ICE intents behind the orders among it — and Blockchair
 * for where a ZEC payout landed.
 */
async function main(): Promise<void> {
  banner(NAME);

  const drain = new Drain(NAME, FLOWS, WATCH);
  await drain.initSchema();

  subscribe((u) => {
    const id = (u.record.seq ?? u.record.id) as string;
    if (u.kind === "created") log.info(`+ [${u.flow}] ${id} [${u.record.state}]`);
    else if (u.previousState !== u.record.state) {
      log.info(`~ [${u.flow}] ${id} [${u.previousState} -> ${u.record.state}]`);
    }
  });

  await serve({ name: NAME, flows: FLOWS, routes });
  await drain.start(drainIntervalMs);
  new PayoutPoller().start();

  log.info("intents-v2 ready.");
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
