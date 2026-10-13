import type { Address } from "viem";

import { WORMHOLE } from "../../chains";
import type { ChainId } from "../../types";

export interface BasejumpRoute {
  source: string;
  sourceChain: ChainId;
  /** BasejumpEmitter proxy on the source chain — the fast-path Wormhole emitter. */
  sourceEmitter: string;
  /** This corridor's BasejumpReceiver on Hydration. One receiver per corridor; only the landing is shared. */
  receiver: Address;
}

/**
 * Mainnet routes, from deployments/prod/basejump-&#42;.json.
 */
export const ROUTES: BasejumpRoute[] = [
  {
    source: "ethereum",
    sourceChain: WORMHOLE.ethereum,
    sourceEmitter: "0xa72e2bf29c840eb93adbb9ee1aa41580f01c9944",
    receiver: "0x35bf3a1b9ac564c8f66c97cea1ee410cd3f97c8a",
  },
];
