import { SUI, SUI_GRAPHQL } from "./consts";
import type { SuiChain } from "./types";

/**
 * Sui's config. Always on: its public GraphQL service needs no key, so `RPC_SUI_GRAPHQL` only
 * overrides it.
 */
export function sui(): SuiChain {
  return {
    ...SUI,
    kind: "sui",
    graphqlUrl: process.env.RPC_SUI_GRAPHQL || SUI_GRAPHQL,
    confirmations: 0n,
    concurrency: 1,
    pollMs: Number(process.env.POLL_MS_SUI ?? 10_000),
  };
}
