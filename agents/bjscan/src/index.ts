import log from "./logger.js";
import * as db from "./db.js";
import { source, destination, pollIntervalMs } from "./config.js";
import { start as startEndpoints } from "./endpoints.js";
import { subscribe } from "./subscribers.js";

import { EvmWatcher } from "./watchers/evm.js";
import { SubstrateWatcher } from "./watchers/substrate.js";
import { Processor } from "./processor.js";

import { base as baseClient, hydration as hydrationClient } from "./clients.js";

import basejump from "./handlers/basejump.js";
import landing from "./handlers/landing.js";
import api from "./handlers/api.js";

const BANNER = String.raw`
 ██████╗      ██╗███████╗ ██████╗ █████╗ ███╗   ██╗
 ██╔══██╗     ██║██╔════╝██╔════╝██╔══██╗████╗  ██║
 ██████╔╝     ██║███████╗██║     ███████║██╔██╗ ██║
 ██╔══██╗██   ██║╚════██║██║     ██╔══██║██║╚██╗██║
 ██████╔╝╚█████╔╝███████║╚██████╗██║  ██║██║ ╚████║
 ╚═════╝  ╚════╝ ╚══════╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═══╝
          basejump transfer indexer
`;

async function main(): Promise<void> {
  console.log(BANNER);
  log.info("bjscan starting...");
  log.info(`  source: ${source.name} @ ${source.contract}`);
  log.info(`  destination: ${destination.name} @ ${destination.contract}`);

  await db.init();

  const base = new EvmWatcher(source, baseClient);
  const hydration = new SubstrateWatcher(destination, hydrationClient);
  const processor = new Processor({ ...basejump, ...landing });

  api(base, hydration);

  subscribe((u) => {
    const t = u.transfer;
    if (u.kind === "created") log.info(`+ ${t.id} [${t.state}]`);
    else if (u.previousState !== t.state) log.info(`~ ${t.id} [${u.previousState} -> ${t.state}]`);
  });

  await startEndpoints();
  await Promise.all([
    base.start(pollIntervalMs),
    hydration.start(pollIntervalMs),
    processor.start(pollIntervalMs),
  ]);

  log.info("bjscan ready.");
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
