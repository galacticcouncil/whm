import type { EmitterRoute } from "../../evm/broadcaster.js";

/** Robinhood Chain mainnet — the chain the emitters below live on. */
export const CHAIN_ID = 4663;

/**
 * Warn once a source's Chainlink round is older than this in open-market time: the feeds' 24h
 * heartbeat plus margin. Logging only — publishing is never held back.
 */
export const STALE_AFTER = 26 * 60 * 60;

/**
 * Mainnet routes, from deployments/prod/oracle-relay-robinhood.json. Every source here is a
 * ChainlinkAdapter, whose `feed()` names the Chainlink proxy watched for staleness.
 */
export const ROUTES: EmitterRoute[] = [
  {
    label: "oracle",
    emitter: "0x9fbd9f16ce7fa17097e91cc36dc1b7b47adca9de",
    symbols: ["SPY"],
    fromBlock: 0n,
  },
];
