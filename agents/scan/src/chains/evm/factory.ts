import type { EvmChainDef } from "./consts";
import type { EvmChain } from "./types";

/**
 * An EVM chain's config from env, or null when no RPC is set (chain disabled). `RPC_<PREFIX>_WSS`
 * subscribes to heads; `RPC_<PREFIX>_HTTP`, for a chain whose endpoint has no websocket, polls them.
 *
 * @param def The chain.
 */
export function evm(def: EvmChainDef): EvmChain | null {
  const { name, chain, wormholeId, prefix } = def;
  const wss = process.env[`RPC_${prefix}_WSS`];
  const rpcUrl = wss || process.env[`RPC_${prefix}_HTTP`];
  if (!rpcUrl) return null;
  if (wss && !wss.startsWith("ws")) {
    throw new Error(`RPC_${prefix}_WSS must be a websocket url (ws:// or wss://).`);
  }
  return {
    name,
    kind: "evm",
    chain,
    wormholeId,
    rpcUrl,
    confirmations: BigInt(process.env[`CONFIRMATIONS_${prefix}`] ?? 3),
    chunkSize: BigInt(process.env[`CHUNK_SIZE_${prefix}`] ?? def.chunkSize ?? 9_000n),
    concurrency: Number(process.env[`CONCURRENCY_${prefix}`] ?? def.concurrency ?? 3),
  };
}
