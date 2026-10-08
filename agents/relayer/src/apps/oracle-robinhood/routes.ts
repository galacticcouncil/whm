import type { Address } from "viem";

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
    sourceEmitter: "0x3f5cc44141a52529323f9be42dbb98fda7c1d066",
    receiver: "0x060f1ef6bb1c7ab31d2bbc3d2ae47e590952b958",
  },
];
