import { HYDRATION } from "./consts";
import type { SubstrateChain } from "./types";

/**
 * Hydration's config from env, or null when its RPC is unset. Read over substrate rather than
 * eth_getLogs — XCM-driven `pallet_evm` calls leave no ethereum receipt — so it has its own shape.
 */
export function hydration(): SubstrateChain | null {
  const wssUrl = process.env.RPC_HYDRATION_WSS;
  if (!wssUrl) return null;
  return {
    ...HYDRATION,
    kind: "substrate",
    wssUrl,
    confirmations: BigInt(process.env.CONFIRMATIONS_HYDRATION ?? 0),
    concurrency: Number(process.env.CONCURRENCY_HYDRATION ?? 100),
    checkpointEvery: Number(process.env.CHECKPOINT_EVERY_HYDRATION ?? 500),
  };
}
