import type { Watch } from "../types";

import { EVM_CHAINS } from "./evm/consts";
import { evm } from "./evm/factory";
import { EvmWatcher } from "./evm/watcher";
import { near } from "./near/factory";
import { NearWatcher } from "./near/watcher";
import { hydration } from "./substrate/factory";
import { SubstrateWatcher } from "./substrate/watcher";
import type { ChainCfg, Watcher } from "./types";

export * from "./cursor";
export * from "./types";
export type { EvmChain } from "./evm/types";
export type { NearChain } from "./near/types";
export type { SubstrateChain } from "./substrate/types";

/**
 * Chain registry. Chain ids, Wormhole ids and tuning live in each chain's `consts`; only the
 * endpoint comes from env, so an operator turns a chain on by setting its RPC and off by unsetting
 * it, and never edits an address. Start blocks are NOT here — they belong to a watch entry, which is
 * what a cursor is kept for.
 */
export const CHAINS: Record<string, ChainCfg> = {};
for (const c of [...EVM_CHAINS.map(evm), hydration(), near()]) {
  if (c) CHAINS[c.name] = c;
}

/**
 * A chain's own id, whichever kind it is — what /api/status reports. NEAR has none.
 *
 * @param c Chain config.
 */
export function chainId(c: ChainCfg): number | null {
  if (c.kind === "evm") return c.chain.id;
  return c.kind === "substrate" ? c.chainId : null;
}

/**
 * The watcher for a chain, by its kind.
 *
 * @param cfg The chain.
 * @param watches Its watch entries.
 * @param onIngest Called with the chain's name whenever new events were stored.
 */
export function watcher(
  cfg: ChainCfg,
  watches: Watch[],
  onIngest: (chain: string) => void,
): Watcher {
  if (cfg.kind === "evm") return new EvmWatcher(cfg, watches, onIngest);
  if (cfg.kind === "near") return new NearWatcher(cfg, watches, onIngest);
  return new SubstrateWatcher(cfg, watches, onIngest);
}
