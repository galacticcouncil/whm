import { banner } from "../banner";
import { CHAINS } from "../chains";
import { drainIntervalMs } from "../config";
import { initCore, notifyEvents } from "../db";
import { Drain, serve } from "../flow";
import log from "../logger";
import type { Watch } from "../types";
import { enabled, WATCH } from "../watch";
import { EvmWatcher, NearWatcher, SubstrateWatcher } from "../watchers";

import { messages } from "./flows/messages";
import { ntt } from "./flows/ntt";

const NAME = "ingest";

/**
 * The single writer.
 *
 * Reads every watched contract into the shared event store, then folds that store into the two
 * tables no feature owns: the Wormhole messages our emitters publish, and the NTT transfers riding
 * them. Both are infrastructure — no feature logic, no pages — so they live here rather than in a
 * container of their own, and everything downstream only ever reads them.
 */
async function main(): Promise<void> {
  banner(NAME);
  await initCore();

  const byChain = new Map<string, Watch[]>();
  for (const w of enabled) byChain.set(w.chain, [...(byChain.get(w.chain) ?? []), w]);
  if (byChain.size === 0) {
    throw new Error("no chain enabled — set an RPC_<CHAIN>_WSS for something in the watch list");
  }

  const watchers = [...byChain].map(([name, watches]) => {
    const cfg = CHAINS[name];
    const nudge = (chain: string) => void notifyEvents(chain);
    if (cfg.kind === "evm") return new EvmWatcher(cfg, watches, nudge);
    if (cfg.kind === "near") return new NearWatcher(cfg, watches, nudge);
    return new SubstrateWatcher(cfg, watches, nudge);
  });

  for (const [name, watches] of byChain) {
    log.info(`  chain: ${name} — ${watches.map((w) => `${w.role}@${w.from}`).join(", ")}`);
  }

  const drain = new Drain(NAME, [messages, ntt], WATCH);
  await drain.initSchema();

  await serve({ name: NAME, flows: [messages, ntt], watchers });
  await Promise.all([...watchers.map((w) => w.start()), drain.start(drainIntervalMs)]);

  log.info("ingest ready.");
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
