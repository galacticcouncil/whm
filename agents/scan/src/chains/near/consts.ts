export const NEAR = { name: "near", wormholeId: 15 } as const;

/** FastNEAR's page size for an account's history, and its cap on transactions per request. */
export const HISTORY_PAGE = 200;
export const TX_BATCH = 20;

/** Slots per receipt in a transaction's log index: the receipt's position × this + the event's. */
export const PER_RECEIPT = 1_000;
