import type { Feature } from "../../types";
import type { Enrich } from "../../enrich";
import { basejumpConfig, chains } from "../../config";

import { basejumpHandlers } from "./handlers";
import { routes } from "./api";
import { initSchema, stateCounts } from "./db";

/**
 * Basejump transfer indexer: source `BridgeInitiated` on EVM chains (Base / optional Ethereum)
 * correlated against the three Hydration landing events. Returns null if no Basejump contract
 * is configured on any enabled chain.
 *
 * @param enrich shared per-chain enrichment passed to the handlers
 */
export function createBasejump(enrich: Enrich): Feature | null {
  const hydration = chains["hydration"];
  const destChainId = hydration?.kind === "substrate" ? hydration.chainId : 0;
  const h = basejumpHandlers(enrich, destChainId);

  const contracts: Feature["contracts"] = [];
  if (chains["base"] && basejumpConfig.base) {
    contracts.push({ chain: "base", address: basejumpConfig.base, events: [h.initiated] });
  }
  if (chains["ethereum"] && basejumpConfig.ethereum) {
    contracts.push({ chain: "ethereum", address: basejumpConfig.ethereum, events: [h.initiated] });
  }
  if (chains["hydration"] && basejumpConfig.hydrationLanding) {
    contracts.push({
      chain: "hydration",
      address: basejumpConfig.hydrationLanding,
      events: [h.executed, h.queued, h.fulfilled],
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
