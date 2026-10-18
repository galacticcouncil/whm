import type { EvmChainDef } from "./consts";
import type { EvmChain } from "./types";

/**
 * An EVM chain's config from env, or null when its RPC is unset (chain disabled).
 *
 * @param def The chain.
 */
export function evm(def: EvmChainDef): EvmChain | null {
  const { name, chain, wormholeId, prefix } = def;
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
