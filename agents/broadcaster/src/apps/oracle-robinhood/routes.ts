import { zeroAddress } from "viem";

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
    emitter: zeroAddress, // TODO: 001-deploy-emitter proxyAddress once oracle-relay-robinhood runs
    symbols: ["SPY"],
    fromBlock: 0n,
  },
];
