import { teraToGas } from "near-api-js";
import { call, checked, view } from "@whm/common/near";

import type { NearContext } from "../types";

/** `IntentRouter.UtxoRoute`. */
export type UtxoRoute = {
  /** The withdraw contract — `A_utxo` derives under it. */
  withdraw: string;
  /** Its derivation path prefix, e.g. `zcash:v1:`. */
  path_prefix: string;
  /** Address prefixes it withdraws to, e.g. `["t1", "t3"]`. */
  address_prefixes: string[];
  /** The least that goes this way — the connector's minimum withdrawal. */
  min_amount: string;
};

export type SetUtxoRouteParams = NearContext & {
  router: string;
  /** Intents ledger id, e.g. `nep141:zec.omft.near`. */
  token: string;
  route: UtxoRoute;
  /** A valid address of the coin, to check the withdraw contract derives under `path_prefix`. */
  sampleAddress: string;
};

export type SetUtxoRouteResult = {
  txHash: string;
  token: string;
  withdraw: string;
  pathPrefix: string;
  addressPrefixes: string;
  minAmount: string;
};

/**
 * Routes a token's withdrawals through its UTXO withdraw contract — its owner calls
 * `set_utxo_route`, 1 yocto — then reads the route back. The withdraw contract is checked first: it
 * must serve the token and derive under the route's prefix, or `A_utxo` would be an account it never
 * signs for.
 *
 * @param params The owner's wallet, the router, the token and its route
 * @returns The transaction and the route now set
 */
export async function setUtxoRoute(params: SetUtxoRouteParams): Promise<SetUtxoRouteResult> {
  const { account, provider, router, token, route, sampleAddress } = params;

  const owner = await view<string>(provider, router, "owner");
  if (owner !== account.accountId) throw new Error(`intent-router is owned by ${owner}, not ${account.accountId}`);
  const { token: served } = await view<{ token: string }>(provider, route.withdraw, "get_params");
  if (`nep141:${served}` !== token) throw new Error(`${route.withdraw} withdraws ${served}, not ${token}`);
  if (!route.address_prefixes.some((p) => sampleAddress.startsWith(p))) {
    throw new Error(`${sampleAddress} matches none of ${route.address_prefixes.join(", ")}`);
  }
  const path = await view<string>(provider, route.withdraw, "path_of", { address: sampleAddress });
  if (path !== `${route.path_prefix}${sampleAddress}`) {
    throw new Error(`${route.withdraw} derives ${sampleAddress} under ${path}, not ${route.path_prefix}`);
  }

  const outcome = checked(
    "set_utxo_route",
    await call(account, router, "set_utxo_route", { token, route }, { deposit: 1n, gas: teraToGas(30) }),
  );

  const routes = await view<Record<string, UtxoRoute>>(provider, router, "utxo_routes");
  if (JSON.stringify(routes[token]) !== JSON.stringify(route)) {
    throw new Error(`intent-router routes ${token} as ${JSON.stringify(routes[token])}`);
  }
  return {
    txHash: outcome.transaction.hash,
    token,
    withdraw: route.withdraw,
    pathPrefix: route.path_prefix,
    addressPrefixes: route.address_prefixes.join(","),
    minAmount: route.min_amount,
  };
}
