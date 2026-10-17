import { isAddress, type Address } from "viem";

export interface NearRoute {
  token: string;
  /** WormholeTransceiver on Hydration — publishes the settlement we subscribe to. */
  transceiver: Address;
  /** The coin's UTXO emitter on Hydration — logs the account beside each settlement. */
  emitter: Address;
  /** NTT manager on NEAR — what the settlement is completed on. */
  manager: string;
}

/**
 * Mainnet routes, one per coin — each coin has its own emitter. Transceivers from
 * deployments/prod/near-ntt-*.json; the emitters are not deployed yet.
 */
export const ROUTES: NearRoute[] = [
  {
    token: "ZEC",
    transceiver: "0x0dd43A80C6F96019B8f5699Df1890DFa33BdDE85",
    emitter: "" as Address,
    manager: "ntt-zec.hydration-whm.near",
  },
];

/**
 * Refuse to run on a route that is still blank or malformed.
 *
 * @throws Naming the first such route.
 */
export function assertRoutes(): void {
  for (const r of ROUTES) {
    if (!isAddress(r.transceiver) || !isAddress(r.emitter)) {
      throw new Error(`ntt-near ${r.token} route is not set — fill it in apps/ntt-near/routes.ts`);
    }
  }
}
