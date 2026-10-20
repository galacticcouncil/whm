import { FASTNEAR_TX_API, NEAR } from "./consts";
import type { NearChain } from "./types";

/**
 * NEAR's config. Always on: FastNEAR's public API needs no key, so `RPC_NEAR_TX` only overrides it.
 * It has no chain id of its own beyond the Wormhole one.
 */
export function near(): NearChain {
  const txApi = process.env.RPC_NEAR_TX || FASTNEAR_TX_API;
  return {
    ...NEAR,
    kind: "near",
    txApi: txApi.replace(/\/$/, ""),
    confirmations: 0n,
    concurrency: Number(process.env.CONCURRENCY_NEAR ?? 3),
    pollMs: Number(process.env.POLL_MS_NEAR ?? 10_000),
  };
}
