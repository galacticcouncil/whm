import { mainnet } from "viem/chains";
import type { Chain } from "viem";

import type { ChainCfg, EvmChain, NearChain, SubstrateChain } from "./types";

/**
 * Chain registry. Chain ids, Wormhole ids and tuning live here; only the endpoint comes from env,
 * so an operator turns a chain on by setting its RPC and off by unsetting it, and never edits an
 * address. Start blocks are NOT here — they belong to a watch entry, which is what a cursor is kept
 * for.
 */

/**
 * Build an EVM chain config, or null when its RPC is unset (chain disabled).
 *
 * @param name Chain name, the key everything else addresses it by.
 * @param chain viem chain.
 * @param wormholeId Wormhole's id for it.
 * @param prefix Env prefix, e.g. `ETHEREUM` for `RPC_ETHEREUM_WSS`.
 */
function evm(name: string, chain: Chain, wormholeId: number, prefix: string): EvmChain | null {
  const rpcUrl = process.env[`RPC_${prefix}_WSS`];
  if (!rpcUrl) return null;
  if (!rpcUrl.startsWith("ws")) {
    throw new Error(`RPC_${prefix}_WSS must be a websocket url (ws:// or wss://).`);
  }
  return {
    name,
    kind: "evm",
    chain,
    wormholeId,
    rpcUrl,
    confirmations: BigInt(process.env[`CONFIRMATIONS_${prefix}`] ?? 3),
    chunkSize: BigInt(process.env[`CHUNK_SIZE_${prefix}`] ?? 9_000),
    concurrency: Number(process.env[`CONCURRENCY_${prefix}`] ?? 3),
  };
}

/**
 * Hydration reads EVM.Log out of substrate events rather than eth_getLogs, so it needs its own
 * shape. Its EVM chain id and its Wormhole id are unrelated numbers and both are load-bearing.
 */
function hydration(): SubstrateChain | null {
  const wssUrl = process.env.RPC_HYDRATION_WSS;
  if (!wssUrl) return null;
  return {
    name: "hydration",
    kind: "substrate",
    chainId: 222_222,
    wormholeId: 73,
    wssUrl,
    confirmations: BigInt(process.env.CONFIRMATIONS_HYDRATION ?? 0),
    concurrency: Number(process.env.CONCURRENCY_HYDRATION ?? 100),
    checkpointEvery: Number(process.env.CHECKPOINT_EVERY_HYDRATION ?? 500),
  };
}

/**
 * NEAR, read through FastNEAR's transaction index — `RPC_NEAR_TX`, e.g. https://tx.main.fastnear.com.
 * It has no chain id of its own beyond the Wormhole one.
 */
function near(): NearChain | null {
  const txApi = process.env.RPC_NEAR_TX;
  if (!txApi) return null;
  return {
    name: "near",
    kind: "near",
    wormholeId: 15,
    txApi: txApi.replace(/\/$/, ""),
    confirmations: 0n,
    concurrency: Number(process.env.CONCURRENCY_NEAR ?? 3),
    pollMs: Number(process.env.POLL_MS_NEAR ?? 10_000),
  };
}

export const CHAINS: Record<string, ChainCfg> = {};
for (const c of [evm("ethereum", mainnet, 2, "ETHEREUM"), hydration(), near()]) {
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
