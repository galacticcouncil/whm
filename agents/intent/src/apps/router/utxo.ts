import type { Terms } from "./terms";

/** `router.utxo_routes()` — one per intents ledger id. */
export interface UtxoRoute {
  /** The withdraw contract — the `predecessor` `A_utxo` is derived under. */
  withdraw: string;
  path_prefix: string;
  address_prefixes: string[];
  min_amount: string;
}

/** wNEAR's ledger id — the router unwraps it to native NEAR, no route needed. */
const WNEAR = "nep141:wrap.near";

/**
 * How the router pays these terms out, as it decides it: an intents transfer, wNEAR as native NEAR,
 * or a withdrawal through the token's UTXO route — nothing else. A route's minimum is the least it
 * delivers at once.
 *
 * @param t The terms.
 * @param routes The router's routes.
 * @returns Whether it can deliver at all, and its minimum.
 */
export function delivery(t: Terms, routes: Record<string, UtxoRoute>): { deliverable: boolean; minPayout: bigint } {
  if (t.recipientKind !== 0 || t.destinationAsset === WNEAR) return { deliverable: true, minPayout: 1n };
  const route = routeFor(t, routes);
  return route ? { deliverable: true, minPayout: BigInt(route.min_amount) } : { deliverable: false, minPayout: 1n };
}

/**
 * The route a delivery of these terms takes, as the router decides it: a withdrawal of a routed
 * token to an address the route accepts.
 *
 * @param t The terms.
 * @param routes The router's routes.
 * @returns The route, or none — POA.
 */
export function routeFor(t: Terms, routes: Record<string, UtxoRoute>): UtxoRoute | undefined {
  const route = routes[t.destinationAsset];
  if (t.recipientKind !== 0 || !route) return undefined;
  return route.address_prefixes.some((p) => t.recipient.startsWith(p)) ? route : undefined;
}
