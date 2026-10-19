export const NEAR = { name: "near", wormholeId: 15 } as const;

/** FastNEAR's public transaction API — free, no key; `RPC_NEAR_TX` overrides it. */
export const FASTNEAR_TX_API = "https://tx.main.fastnear.com";

/** FastNEAR's page size for an account's history, and its cap on transactions per request. */
export const HISTORY_PAGE = 200;
export const TX_BATCH = 20;

/** Slots per receipt in a transaction's log index: the receipt's position × this + the event's. */
export const PER_RECEIPT = 1_000;

/**
 * How many blocks past an unfinished transaction the cursor waits for it — well past a yielded
 * receipt's timeout, so only a transaction the index never completes is taken as it stands.
 */
export const HOLD_BLOCKS = 600n;
