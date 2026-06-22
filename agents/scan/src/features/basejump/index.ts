import type { Feature } from "../../types";
import type { Enrich } from "../../enrich";
import { basejumpConfig, chains } from "../../config";

import { basejumpHandlers } from "./handlers";
import { routes } from "./api";
import { initSchema, stateCounts } from "./db";

/**
 * Basejump transfer indexer: source `BridgeInitiated` on EVM chains correlated against the landing
 * delivery events. Supports one or more landing deployments (the single shared landing, or several
 * separate-harness landings each with its own address) — all merged into one unified transfers
 * view. Returns null if no Basejump contract is configured on any enabled chain.
 *
 * @param enrich shared per-chain enrichment passed to the handlers
 */
export function createBasejump(enrich: Enrich): Feature | null {
  const h = basejumpHandlers(enrich);
  const contracts: Feature["contracts"] = [];

  // Source bridges (BridgeInitiated → `initiated`): one entry per address, per enabled source chain.
  for (const [chain, addresses] of Object.entries(basejumpConfig.sources)) {
    if (!chains[chain]) continue;
    for (const address of addresses) {
      contracts.push({ chain, address, events: [h.initiated] });
    }
  }

  // Landings (delivery events). Each landing gets a dest chain id resolved from its chain; distinct
  // landing addresses route independently via (chain,address,topic0).
  for (const l of basejumpConfig.landings) {
    const chainCfg = chains[l.chain];
    if (!chainCfg) continue;
    const destChainId = chainCfg.kind === "substrate" ? chainCfg.chainId : chainCfg.chain.id;
    const lh = h.landing(destChainId);
    contracts.push({
      chain: l.chain,
      address: l.address,
      events: [lh.executed, lh.queued, lh.fulfilled],
    });
  }

  if (contracts.length === 0) return null;

  return {
    name: "basejump",
    contracts,
    initSchema,
    routes,
    counts: stateCounts,
  };
}
