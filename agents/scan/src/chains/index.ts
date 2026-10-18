import type { Watch } from "../types";

import { EVM_CHAINS } from "./evm/consts";
import { evm } from "./evm/factory";
import { EvmWatcher } from "./evm/watcher";
import { NEAR } from "./near/consts";
import { near } from "./near/factory";
import { NearWatcher } from "./near/watcher";
import { SOLANA } from "./solana/consts";
import { solana } from "./solana/factory";
import { SolanaWatcher } from "./solana/watcher";
import { HYDRATION } from "./substrate/consts";
import { hydration } from "./substrate/factory";
import { SubstrateWatcher } from "./substrate/watcher";
import { SUI } from "./sui/consts";
import { sui } from "./sui/factory";
import { SuiWatcher } from "./sui/watcher";
import type { ChainCfg, Watcher } from "./types";

export * from "./cursor";
export * from "./types";
export type { EvmChain } from "./evm/types";
export type { NearChain } from "./near/types";
export type { SolanaChain } from "./solana/types";
export type { SubstrateChain } from "./substrate/types";
export type { SuiChain } from "./sui/types";

/**
 * Chain registry. Chain ids, Wormhole ids and tuning live in each chain's `consts`; only the
 * endpoint comes from env, so an operator turns a chain on by setting its RPC and off by unsetting
 * it, and never edits an address. Start blocks are NOT here — they belong to a watch entry, which is
 * what a cursor is kept for.
 */
export const CHAINS: Record<string, ChainCfg> = {};
for (const c of [...EVM_CHAINS.map(evm), hydration(), near(), solana(), sui()]) {
  if (c) CHAINS[c.name] = c;
}

/**
 * Every chain a Wormhole message may name, by its Wormhole id. Static — unlike `CHAINS`, it does not
 * depend on which endpoints this process was given.
 */
export const WORMHOLE_CHAINS: Record<number, string> = Object.fromEntries(
  [...EVM_CHAINS, HYDRATION, NEAR, SOLANA, SUI].map((c) => [c.wormholeId, c.name]),
);

/**
 * A chain's Wormhole id by name, endpoint or not — for readers, which have none.
 *
 * @param name Chain name.
 */
export function wormholeId(name: string): number {
  const id = Object.entries(WORMHOLE_CHAINS).find(([, n]) => n === name)?.[0];
  if (id === undefined) throw new Error(`no Wormhole id for ${name}`);
  return Number(id);
}

/**
 * A chain's own id, whichever kind it is — what /api/status reports. NEAR, Solana and Sui have none.
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
  if (cfg.kind === "solana") return new SolanaWatcher(cfg, watches, onIngest);
  if (cfg.kind === "sui") return new SuiWatcher(cfg, watches, onIngest);
  return new SubstrateWatcher(cfg, watches, onIngest);
}
