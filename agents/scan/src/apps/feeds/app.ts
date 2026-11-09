import { banner } from "../../banner";
import { drainIntervalMs } from "../../config";
import { Drain, serve, subscribe } from "../../flow";
import log from "../../logger";
import { WATCH } from "../../watch";

import { routes } from "./api";
import { prune } from "./db";
import { updates } from "./flows";

const NAME = "feeds";
const FLOWS = [updates];
const PRUNE_MS = 60 * 60_000;

/**
 * The oracle relays: every update a source emitter publishes, matched to the receiver that wrote
 * it — and each feed's value over time.
 */
async function main(): Promise<void> {
  banner(NAME);

  const drain = new Drain(NAME, FLOWS, WATCH);
  await drain.initSchema();

  subscribe((u) => {
    if (u.kind === "created") log.info(`+ [${u.flow}] ${u.record.id} [${u.record.state}]`);
    else if (u.previousState !== u.record.state) {
      log.info(`~ [${u.flow}] ${u.record.id} [${u.previousState} -> ${u.record.state}]`);
    }
  });

  await serve({ name: NAME, flows: FLOWS, routes });
  await drain.start(drainIntervalMs);

  // Postgres has no TTL: a month is kept, the rest pruned hourly.
  const pruneOld = () =>
    prune()
      .then((n) => n > 0 && log.info(`pruned ${n} updates older than 30 days`))
      .catch((e) => log.error(`prune: ${(e as Error).message}`));
  void pruneOld();
  setInterval(pruneOld, PRUNE_MS);

  log.info("feeds ready.");
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
