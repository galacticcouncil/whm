import type { EmitterRoute } from "../../evm/broadcaster.js";

/** Hydration EVM — the chain the emitters below live on. */
export const CHAIN_ID = 222222;

/**
 * Mainnet routes, from deployments/prod/oracle-relay-hydration.json. Every source here is an
 * AggregatorAdapter over Hydration's EMA oracle precompile — answer-only, so no round to watch.
 */
export const ROUTES: EmitterRoute[] = [
  {
    label: "oracle",
    emitter: "0x3f5cc44141a52529323f9be42dbb98fda7c1d066",
    symbols: ["HDX"],
    fromBlock: 0n,
  },
];
