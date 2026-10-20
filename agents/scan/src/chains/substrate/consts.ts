/**
 * Hydration. Its EVM chain id and its Wormhole id are unrelated numbers and both are load-bearing.
 */
export const HYDRATION = { name: "hydration", chainId: 222_222, wormholeId: 73 } as const;

/** `System.Events`' storage key: twox128("System") ++ twox128("Events"). Read raw, decoded rarely. */
export const SYSTEM_EVENTS_KEY =
  "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7";

/**
 * Blocks read per call: their hashes in one `chain_getBlockHash`, their events in one
 * `state_queryStorage`. Kept small enough that a run of heavy blocks stays under a node's response
 * size limit.
 */
export const RANGE = 100n;

/** Log backfill progress at most this often. */
export const PROGRESS_LOG_MS = 10_000;
