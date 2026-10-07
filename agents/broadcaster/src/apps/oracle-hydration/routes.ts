import { zeroAddress } from "viem";

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
    emitter: zeroAddress, // TODO: 001-deploy-emitter proxyAddress once oracle-relay-hydration runs
    symbols: ["HDX"],
    fromBlock: 0n,
  },
];
