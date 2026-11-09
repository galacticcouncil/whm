import { isAddress, type Address } from "viem";

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

/** Placeholder for a corridor whose migration has not run yet. A route holding it is not relayed. */
export const NOT_DEPLOYED = "0x0000000000000000000000000000000000000000";

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
  {
    // EURC. Fill both from deployments/prod/basejump-base.json once `pnpm migrate:basejump-base`
    // has run: sourceEmitter = 001-deploy-emitter.proxyAddress, receiver = 005-deploy-receiver
    // .proxyAddress. Until then the app skips this route (see app.ts). The emitter stays
    // disarmed until the Base TC Safe arms it after this route is live. Checklist:
    // docs/basejump/base-eurc.md.
    source: "base",
    sourceChain: WORMHOLE.base,
    sourceEmitter: NOT_DEPLOYED,
    receiver: NOT_DEPLOYED,
  },
];

/** A real, non-zero 20-byte address: anything else ("", "0x0", the placeholder) counts as unfilled. */
const filled = (a: string): boolean => isAddress(a, { strict: false }) && a.toLowerCase() !== NOT_DEPLOYED;

/** A route both of whose addresses are filled in. */
export const isDeployed = (route: BasejumpRoute): boolean => filled(route.sourceEmitter) && filled(route.receiver);
