import type { EmitterRoute } from "../../evm/broadcaster.js";

/** Ethereum mainnet — the chain the emitters below live on. */
export const CHAIN_ID = 1;

/**
 * Mainnet routes, from deployments/prod/oracle-relay-ethereum.json.
 */
export const ROUTES: EmitterRoute[] = [
  {
    label: "oracle",
    emitter: "0xfbf682642a6a28760e717b637f12d014bd5db4b9",
    symbols: ["WSTETH", "APYUSD"],
    fromBlock: 0n,
  },
];
