import api from "./api";
import log from "./logger";
import * as db from "./db";

import { start as startEndpoints } from "./endpoints";
import { subscribe } from "./subscribers";

import { Processor } from "./processor";
import { EvmWatcher, SubstrateWatcher } from "./watchers";

import { source, destination, pollIntervalMs } from "./config";
import { sourceClient, destinationClient } from "./clients";

import { basejump, landing } from "./handlers";

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

  const srcWatch = new EvmWatcher(source, sourceClient);
  const dstWatch = new SubstrateWatcher(destination, destinationClient);
  const processor = new Processor({ ...basejump(sourceClient), ...landing(destinationClient) });

  api(srcWatch, dstWatch);

  subscribe((u) => {
    const t = u.transfer;
    if (u.kind === "created") log.info(`+ ${t.id} [${t.state}]`);
    else if (u.previousState !== t.state) log.info(`~ ${t.id} [${u.previousState} -> ${t.state}]`);
  });

  await startEndpoints();
  await Promise.all([
    srcWatch.start(pollIntervalMs),
    dstWatch.start(pollIntervalMs),
    processor.start(pollIntervalMs),
  ]);

  log.info("bjscan ready.");
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
