import { zeroAddress, type Address } from "viem";

import { WORMHOLE } from "../../chains";
import type { ChainId } from "../../types";

export interface OracleRoute {
  source: string;
  sourceChain: ChainId;
  /** Origin OracleEmitter (EVM). */
  sourceEmitter: Address;
  /** OracleReceiver on Robinhood for this source. Each source has its own deployment. */
  receiver: Address;
}

/**
 * Mainnet routes, from deployments/prod/oracle-relay-hydration.json.
 */
export const ROUTES: OracleRoute[] = [
  {
    source: "hydration",
    sourceChain: WORMHOLE.hydration,
    sourceEmitter: zeroAddress, // TODO: 001-deploy-emitter proxyAddress once oracle-relay-hydration runs
    receiver: zeroAddress, // TODO: 003-deploy-receiver proxyAddress
  },
];
