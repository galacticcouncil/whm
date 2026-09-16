import type { Address } from "viem";

import { WORMHOLE } from "../../chains";
import type { ChainId } from "../../types";

export interface OracleRoute {
  source: string;
  sourceChain: ChainId;
  /**
   * Origin emitter. Solana gives the oracle-emitter program id — its emitter PDA is
   * `seeds = [b"emitter"]`, which relayer-engine derives before subscribing.
   */
  sourceEmitter: string;
  /** OracleReceiver on Hydration for this source. Each source has its own deployment. */
  receiver: Address;
}

/**
 * Mainnet routes, from deployments/prod/oracle-relay-&#42;.json.
 */
export const ROUTES: OracleRoute[] = [
  {
    source: "solana",
    sourceChain: WORMHOLE.solana,
    sourceEmitter: "2knjvgqZKtU3nV1r9RaLshS9JYWMerZ1ysSFcDyTVsdn",
    receiver: "0x582e2fac5af62dc024396b5e7f549c72273a69c3",
  },
  {
    source: "ethereum",
    sourceChain: WORMHOLE.ethereum,
    sourceEmitter: "0xfbf682642a6a28760e717b637f12d014bd5db4b9",
    receiver: "0x6913770466fed4dbc24337cd7f1ae92af4321083",
  },
];
