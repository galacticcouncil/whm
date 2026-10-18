export const SUI = { name: "sui", wormholeId: 21 } as const;

/** Sui's public GraphQL — its JSON-RPC is gone from public fullnodes; `RPC_SUI_GRAPHQL` overrides it. */
export const SUI_GRAPHQL = "https://graphql.mainnet.sui.io/graphql";

/** Transactions per GraphQL page, the service's cap. */
export const TX_PAGE = 50;

/** Slots per transaction in its log index: calls first, then events. */
export const EVENTS_AT = 1_000;
