import type { JsonRpcProvider } from "near-api-js";

import { view } from "../utils";

import { deriveAccount } from "./account";

/** wNEAR's ledger id — the router pays it out as native NEAR. */
export const WNEAR = "nep141:wrap.near";

/** The destinations intents v2 pays out on their home chains, by short name. */
export const DESTINATIONS: Record<string, string> = {
  zec: "nep141:zec.omft.near",
  btc: "nep141:nbtc.bridge.near",
  near: WNEAR,
};

/** A NEAR account id: lowercase parts joined by `.`, 2 to 64 characters. */
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** The router's way out to a coin's own chain: `utxo_routes()`'s value. */
export interface UtxoRoute {
  /** The withdraw contract — `A_utxo`'s predecessor. */
  withdraw: string;
  path_prefix: string;
  address_prefixes: string[];
  /** The least the router pays out at once, in the token's base units. */
  min_amount: string;
}

/**
 * A destination's ledger id.
 *
 * @param nameOrId A short name from `DESTINATIONS`, or a ledger id as is
 * @returns The ledger id
 */
export function destination(nameOrId: string): string {
  return DESTINATIONS[nameOrId] ?? nameOrId;
}

/**
 * The router's UTXO routes.
 *
 * @param provider A NEAR provider
 * @param router The intent router
 * @returns Each route, by intents ledger id
 */
export function utxoRoutes(provider: JsonRpcProvider, router: string): Promise<Record<string, UtxoRoute>> {
  return view<Record<string, UtxoRoute>>(provider, router, "utxo_routes", {});
}

/**
 * How the router will pay a set of terms out, checked before anything is spent: what it would not
 * deliver is refused here. A withdrawal (kind 0) goes through the token's UTXO route — the route's
 * withdraw contract validates the address itself, as it will when withdrawing — or, for wNEAR, as
 * native NEAR to an existing account; a transfer (kind 1) needs a NEAR account id.
 *
 * @param provider A NEAR provider
 * @param router The intent router
 * @param asset The destination's ledger id
 * @param kind The terms' `recipientKind`
 * @param recipient The terms' recipient
 * @returns The UTXO route the payout takes, or none
 * @throws When the router would not deliver to `recipient`
 */
export async function checkRecipient(
  provider: JsonRpcProvider,
  router: string,
  asset: string,
  kind: number,
  recipient: string,
): Promise<UtxoRoute | undefined> {
  if (kind !== 0) {
    if (!ACCOUNT_ID.test(recipient)) throw new Error(`${recipient} is no NEAR account id`);
    return undefined;
  }
  if (asset === WNEAR) {
    await provider.viewAccount({ accountId: recipient }).catch(() => {
      throw new Error(`${recipient} is no NEAR account: intents.near would keep the NEAR`);
    });
    return undefined;
  }
  const route = (await utxoRoutes(provider, router))[asset];
  if (!route) throw new Error(`${router} has no UTXO route for ${asset}: it would refuse the swap and only refund`);
  if (!route.address_prefixes.some((p) => recipient.startsWith(p))) {
    throw new Error(`${route.withdraw} takes ${route.address_prefixes.join(" / ")} addresses, not ${recipient}`);
  }
  await view<string>(provider, route.withdraw, "path_of", { address: recipient }).catch((e: Error) => {
    throw new Error(`${route.withdraw} rejects ${recipient}: ${e.message}`);
  });
  return route;
}

/** Where a trade's payout goes on a UTXO route: `A_utxo` and the token it holds there. */
export interface UtxoLeg {
  token: string;
  account: string;
}

/**
 * `A_utxo` for a recipient on a route: the withdraw contract's account for the address.
 *
 * @param provider A NEAR provider
 * @param route The route
 * @param asset The destination's ledger id
 * @param recipient The address
 * @returns `A_utxo` and the token contract it holds
 */
export async function utxoLeg(provider: JsonRpcProvider, route: UtxoRoute, asset: string, recipient: string): Promise<UtxoLeg> {
  const account = await deriveAccount(provider, route.withdraw, `${route.path_prefix}${recipient}`);
  return { token: asset.replace(/^nep141:/, ""), account };
}
