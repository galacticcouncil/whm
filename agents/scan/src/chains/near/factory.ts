import { NEAR } from "./consts";
import type { NearChain } from "./types";

/**
 * NEAR's config from env, or null when unset — `RPC_NEAR_TX`, FastNEAR's transaction API, e.g.
 * https://tx.main.fastnear.com. It has no chain id of its own beyond the Wormhole one.
 */
export function near(): NearChain | null {
  const txApi = process.env.RPC_NEAR_TX;
  if (!txApi) return null;
  return {
    ...NEAR,
    kind: "near",
    txApi: txApi.replace(/\/$/, ""),
    confirmations: 0n,
    concurrency: Number(process.env.CONCURRENCY_NEAR ?? 3),
    pollMs: Number(process.env.POLL_MS_NEAR ?? 10_000),
  };
}
