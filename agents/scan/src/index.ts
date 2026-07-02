import { toEventSelector } from "viem";

import log from "./logger";
import { initCore } from "./db";
import { chains, pollIntervalMs } from "./config";
import { clients } from "./clients";
import { Enrich } from "./enrich";
import { EvmWatcher, SubstrateWatcher, type WatchedAddress } from "./watchers";
import { Processor, routeKey, type HandlerRegistry } from "./processor";
import { buildFeatures } from "./features";
import { app, coreRoutes, start as startApi } from "./api/server";
import { uiRoutes } from "./api/ui";
import { subscribe } from "./subscribers";

const BANNER = String.raw`
 ███████╗ ██████╗ █████╗ ███╗   ██╗
 ██╔════╝██╔════╝██╔══██╗████╗  ██║
 ███████╗██║     ███████║██╔██╗ ██║
 ╚════██║██║     ██╔══██║██║╚██╗██║
 ███████║╚██████╗██║  ██║██║ ╚████║
 ╚══════╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═══╝
   whm multi-feature event indexer
`;

async function main(): Promise<void> {
  console.log(BANNER);
  log.info("scan starting...");

  await initCore();

  const enrich = new Enrich(clients);
  const features = buildFeatures(enrich);
  if (features.length === 0) {
    throw new Error("no features enabled — check chain RPCs (env) and contract addresses");
  }

  for (const f of features) await f.initSchema();

  // Build the handler registry and the per-chain watched-contract sets from feature manifests.
  const registry: HandlerRegistry = new Map();
  const evmContracts: Record<string, WatchedAddress[]> = {};
  const subContracts: Record<string, `0x${string}`[]> = {};

  for (const f of features) {
    for (const c of f.contracts) {
      const chainCfg = chains[c.chain];
      if (!chainCfg) {
        log.warn(`[${f.name}] chain "${c.chain}" not enabled — skipping ${c.address}`);
        continue;
      }
      for (const ev of c.events) {
        registry.set(routeKey(c.chain, c.address, toEventSelector(ev.abi)), ev);
      }
      if (chainCfg.kind === "evm") {
        (evmContracts[c.chain] ??= []).push({ address: c.address, topics: c.topics });
      } else {
        (subContracts[c.chain] ??= []).push(c.address);
      }
    }
  }

  const processor = new Processor(registry, Object.keys(chains));
  const nudge = () => processor.trigger();

  const watchers: Array<EvmWatcher | SubstrateWatcher> = [];
  for (const [name, cfg] of Object.entries(chains)) {
    if (cfg.kind === "evm") {
      const cs = evmContracts[name];
      if (cs?.length) watchers.push(new EvmWatcher(cfg, cs, clients[name].evm!, nudge));
    } else {
      const cs = subContracts[name];
      if (cs?.length) watchers.push(new SubstrateWatcher(cfg, cs, clients[name].substrate!, nudge));
    }
  }

  for (const f of features) f.routes(app);
  coreRoutes(features, watchers);
  uiRoutes(app, features);

  subscribe((u) => {
    const id = (u.record.id ?? u.record.intent_id) as string;
    const state = u.record.state as string;
    if (u.kind === "created") log.info(`+ [${u.feature}] ${id} [${state}]`);
    else if (u.previousState !== state)
      log.info(`~ [${u.feature}] ${id} [${u.previousState} -> ${state}]`);
  });

  for (const f of features) {
    log.info(
      `  feature: ${f.name} — ${f.contracts.map((c) => `${c.chain}:${c.address}`).join(", ")}`,
    );
  }

  await startApi();
  await Promise.all([...watchers.map((w) => w.start()), processor.start(pollIntervalMs)]);

  for (const f of features) f.start?.();

  log.info("scan ready.");
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
