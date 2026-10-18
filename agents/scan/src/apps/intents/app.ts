import { banner } from "../../banner";
import { drainIntervalMs } from "../../config";
import { Drain, serve, subscribe } from "../../flow";
import log from "../../logger";
import { WATCH } from "../../watch";

import { routes } from "./api";
import { orders } from "./flows";
import { tokenMetadata } from "./metadata";
import { SettlementPoller } from "./settlement";

const NAME = "intents";
const FLOWS = [orders];

/**
 * NEAR-Intents: orders placed on Hydration and forwarded on Ethereum, beside the standing
 * authorizations they may derive from.
 *
 * Reads the event store ingest fills and owns nothing else — the Wormhole and NTT tables it joins
 * against belong to ingest, and no chain is touched here except once at boot for asset symbols.
 */
async function main(): Promise<void> {
  banner(NAME);

  const drain = new Drain(NAME, FLOWS, WATCH);
  await drain.initSchema();

  subscribe((u) => {
    const id = u.record.transfer_sequence as string;
    if (u.kind === "created") log.info(`+ [${u.flow}] ${id} [${u.record.state}]`);
    else if (u.previousState !== u.record.state) {
      log.info(`~ [${u.flow}] ${id} [${u.previousState} -> ${u.record.state}]`);
    }
  });

  await serve({ name: NAME, flows: FLOWS, routes });
  await drain.start(drainIntervalMs);

  void tokenMetadata(); // warm the cache so /api/tokens is instant
  new SettlementPoller().start();

  log.info("intents ready.");
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
