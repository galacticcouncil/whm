import type { Address } from "viem";

import { optional, optionalNumber, required } from "../../env";

export const APP_NAME = "relayer";

export interface Route {
  /** A key of `CHAINS`. */
  chain: string;
  /** The coin's emitter on Hydration. */
  emitter: Address;
  /** Its deployment block — where a fresh store starts reading. */
  from: bigint;
}

/**
 * One route per coin — each coin has its own emitter. Not deployed yet: the app refuses to run
 * until a route is filled in from deployments/prod/<its migration>.json.
 */
export const routes: Route[] = [{ chain: "zcash", emitter: "" as Address, from: 0n }];

/** Hydration reads EVM.Log out of substrate events rather than eth_getLogs — see scan. */
export const hydration = {
  wssUrl: required("RPC_HYDRATION_WSS"),
  confirmations: BigInt(optional("CONFIRMATIONS_HYDRATION", "0")),
  concurrency: optionalNumber("CONCURRENCY_HYDRATION", 20),
  checkpointEvery: 500n,
};

export const near = {
  /** rpc.mainnet.near.org is deprecated and throttles; fastnear is the free default. */
  rpcUrl: optional("RPC_NEAR", "https://free.rpc.fastnear.com"),
  accountId: required("NEAR_ACCOUNT_ID"),
  privateKey: required("NEAR_PRIVKEY").trim(),
};

export const redis = {
  host: optional("REDIS_HOST", "localhost"),
  port: optionalNumber("REDIS_PORT", 6379),
  /** LOAD-BEARING — every key starts with it; changing it orphans the cursor and open records. */
  prefix: optional("REDIS_PREFIX", "utxo"),
};

/** Backstop for the watcher; the real trigger is the finalized-block subscription. */
export const liveIntervalMs = optionalNumber("LIVE_INTERVAL_MS", 12_000);

/** How often open withdrawals are retried until processed. */
export const workIntervalMs = optionalNumber("WORK_INTERVAL_MS", 30_000);

/** An open withdrawal older than this is logged, once per interval. */
export const stuckMs = 60 * 60_000;
