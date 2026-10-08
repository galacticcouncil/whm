import { isAddress, type Address } from "viem";

import { WORMHOLE } from "../../chains";
import type { ChainId } from "../../types";

/**
 * A route names a source emitter and its chain, and a destination contract and its chain. The
 * corridor's two directions are two routes rather than two concepts — nothing here says which
 * direction is "forward": a route between two chains where neither is Hydration has exactly the
 * same shape.
 *
 * `sourceEmitter` is typed `Address` (a 20-byte EVM address), not `string` — that restricts every
 * corridor this table can express to an EVM source. `ntt`'s routes.ts types the same field `string`
 * for exactly this reason: its Solana routes carry a base58 program id, which `onEmitter`'s
 * `pad(emitter, { size: 32 })` cannot accept, and which relayer-engine derives an emitter PDA from
 * rather than padding directly (see `ntt`'s own doc comment). Adding a non-EVM source here is a
 * type change on this field plus a registration-path change in `app.ts`'s `wireRoutes` (it would
 * need to branch on how to derive the subscription key), not one table entry.
 */
export interface PsmRoute {
  /** Short label for logs — not read by any relaying logic. */
  name: string;
  /** Where this route's VAAs originate. */
  sourceChain: ChainId;
  /** Contract on the source chain whose messages we subscribe to. */
  sourceEmitter: Address;
  /** Where the VAA is delivered — what process (and wallet) serves this route. */
  destinationChain: ChainId;
  /** Contract on the destination chain that receives the VAA via `receiveMessage`. */
  destinationContract: Address;
}

/**
 * Both PSM corridor directions, as data.
 *
 * Mainnet addresses, from deployments/prod/psm-base.json once the migration runs. Both PSM
 * contracts (HollarBaseVault on Base, HollarBaseFacilitator on Hydration — contracts/src/psm/) are
 * unknown until then, so this ships blank, following the intents precedent in ../intent/routes.ts:
 * the app refuses to start while any address here is blank or malformed, rather than silently
 * no-op-ing or accepting a placeholder.
 *
 * Each contract plays both roles on its own chain: HollarBaseVault is the source emitter for
 * "mint" AND the destination contract for "redeem"; HollarBaseFacilitator is the destination
 * contract for "mint" AND the source emitter for "redeem". `routesFor` enforces that as a closure
 * invariant across the table (see `assertCorridorClosure`) — filling these two rows with two
 * addresses that are individually valid but do not close the corridor (the classic mistake: pasting
 * a route's emitter and contract into each other's column) is rejected, named, rather than accepted
 * on trust.
 *
 * Kinds, for context (the relayer never parses the payload, it only moves VAA bytes; the only
 * VAA fields read are its sequence and its raw bytes). The route names are historical labels for
 * the two directions, not a statement of which kinds each carries (PsmPayload, contracts/src/psm):
 *   - "mint" (Base to Hydration) carries kind 1 (mint) and kind 4 (re-mint). Kind 1 comes from
 *     HollarBaseVault.deposit, and from the vault's cancel of a refund-derived credit
 *     (cancelQueuedRedemption, cancelQueuedRedemptionFor). Kind 4 comes from the vault's cancel of
 *     a queued redemption credit, and from a redemption returned because the fee exceeded the
 *     limit it carried.
 *   - "redeem" (Hydration to Base) carries kind 2 (redeem) and kind 3 (refund). Kind 2 comes from
 *     HollarBaseFacilitator.redeem, and from the facilitator's cancel of a re-mint-derived pending
 *     mint. Kind 3 comes from its cancel of a deposit-derived pending mint (cancelPendingMint,
 *     cancelPendingMintFor).
 */
const ROUTE_TABLE: PsmRoute[] = [
  {
    name: "mint",
    sourceChain: WORMHOLE.base,
    sourceEmitter: "" as Address, // HollarBaseVault on Base — filled at deploy
    destinationChain: WORMHOLE.hydration,
    destinationContract: "" as Address, // HollarBaseFacilitator on Hydration — filled at deploy
  },
  {
    name: "redeem",
    sourceChain: WORMHOLE.hydration,
    sourceEmitter: "" as Address, // HollarBaseFacilitator on Hydration — filled at deploy
    destinationChain: WORMHOLE.base,
    destinationContract: "" as Address, // HollarBaseVault on Base — filled at deploy
  },
];

/** Every Wormhole chain id this codebase knows about — see `../../chains`. */
const KNOWN_CHAINS = new Set<ChainId>(Object.values(WORMHOLE));

/**
 * Confirm `route[field]` names a chain this codebase recognises.
 *
 * A typo'd `sourceChain` (e.g. `3` for `30`) would otherwise wire a real subscription under a
 * chain nothing ever publishes on — the route relays nothing, forever, with no error. A typo'd
 * `destinationChain` is worse: it just fails to match any process's `routesFor` filter and vanishes
 * from service entirely, while `makeApp` still finds its OTHER route and starts up looking healthy.
 * Checked against the WHOLE table in `routesFor`, before filtering, specifically to catch that
 * second case — a row this call's destination does not currently want is exactly the row a typo'd
 * `destinationChain` produces.
 *
 * @throws Naming the route and the field, with the bad value, when it does not match any id in
 *   `WORMHOLE` (`../../chains`).
 */
function validateChainId(route: PsmRoute, field: "sourceChain" | "destinationChain"): void {
  const value = route[field];
  if (!KNOWN_CHAINS.has(value)) {
    throw new Error(
      `psm route "${route.name}" ${field} ${value} is not a recognised Wormhole chain id ` +
        `(see WORMHOLE in ../../chains) — fix it in apps/psm/routes.ts`,
    );
  }
}

/** The two address fields a route must carry before it can be served. */
const ADDRESS_FIELDS = ["sourceEmitter", "destinationContract"] as const;

/**
 * Validate one address field, naming exactly which route and field is wrong, and distinguishing
 * "never filled in" from "filled in with something that isn't an address" — the two have different
 * fixes, and conflating them under one message ("is not set") was misleading for the second case.
 *
 * @throws When the field is blank (never filled in) or present but not a valid address.
 */
function validateAddressField(route: PsmRoute, field: (typeof ADDRESS_FIELDS)[number]): void {
  const value = route[field];
  if ((value as string) === "") {
    throw new Error(
      `psm route "${route.name}" ${field} is not set — fill it in apps/psm/routes.ts`,
    );
  }
  if (!isAddress(value)) {
    throw new Error(
      `psm route "${route.name}" ${field} "${value}" is not a valid address — fix it in apps/psm/routes.ts`,
    );
  }
}

/**
 * Validate one route's chain ids and addresses, naming exactly which route and which field is
 * wrong.
 *
 * @param route Route to check.
 * @returns The same route, for chaining in a `.map`.
 * @throws See `validateChainId` and `validateAddressField`.
 */
function validateRoute(route: PsmRoute): PsmRoute {
  validateChainId(route, "sourceChain");
  validateChainId(route, "destinationChain");
  for (const field of ADDRESS_FIELDS) {
    validateAddressField(route, field);
  }
  return route;
}

/**
 * Confirm the table closes: for every pair of routes that are each other's round trip (A's
 * destination is B's source chain and vice versa), A's destination contract must be the same
 * contract as B's source emitter, and B's destination contract must be the same contract as A's
 * source emitter — each contract is both the receiver and the emitter of its own side.
 *
 * This is a structural check, not a chain-verified one: it catches an address copied into the wrong
 * column (a source emitter and a destination contract swapped within one route, which individually
 * still pass `isAddress`), but it cannot catch the two real corridor addresses swapped consistently
 * across BOTH routes — that fill still closes under this rule, since the pairing it checks is
 * relative, not tied to which physical chain either address actually has code on. Closing that gap
 * needs on-chain verification against deployed bytecode, which is out of scope for a route table.
 * Filling this table correctly remains, to that extent, deploy-time trust.
 *
 * A route with no round-trip counterpart in `table` (the general N-corridor case, or a synthetic
 * table built for one direction only) has nothing to close against and is skipped.
 *
 * @throws Naming both routes, when a matched pair does not close.
 */
function assertCorridorClosure(table: PsmRoute[]): void {
  for (const a of table) {
    const b = table.find(
      (r) => r !== a && r.sourceChain === a.destinationChain && r.destinationChain === a.sourceChain,
    );
    if (!b) continue;
    if (a.destinationContract.toLowerCase() !== b.sourceEmitter.toLowerCase()) {
      throw new Error(
        `psm corridor closure broken: "${a.name}".destinationContract must equal "${b.name}".sourceEmitter ` +
          `— they are the same contract on chain ${a.destinationChain} — fix apps/psm/routes.ts`,
      );
    }
  }
}

/**
 * Confirm no two routes served by the same process subscribe to the same (sourceChain,
 * sourceEmitter) — `onEmitter` assigns into a plain map keyed on exactly that pair, so a second
 * route sharing it would silently overwrite the first's handler rather than composing with it, and
 * whichever route lost would relay nothing with no error.
 *
 * @param routes The routes about to be served by ONE process (already filtered to one destination).
 * @throws Naming both routes, when two share a (sourceChain, sourceEmitter) key.
 */
function assertNoDuplicateSources(routes: PsmRoute[]): void {
  const seen = new Map<string, string>();
  for (const route of routes) {
    const key = `${route.sourceChain}:${route.sourceEmitter.toLowerCase()}`;
    const existing = seen.get(key);
    if (existing) {
      throw new Error(
        `psm routes "${existing}" and "${route.name}" both subscribe to the same source ` +
          `(chain ${route.sourceChain}, ${route.sourceEmitter}) — onEmitter would silently keep only ` +
          `the last one registered — fix apps/psm/routes.ts`,
      );
    }
    seen.set(key, route.name);
  }
}

/**
 * Every route landing on `destinationChain`, validated.
 *
 * Every row of `table` is checked — chain ids, addresses, and the corridor's closure invariant —
 * before filtering, not just the rows landing on `destinationChain`. A row this call does not serve
 * still shares the table with one this call does, and the closure check is inherently about the
 * relationship between two rows; validating only the served subset would let a defect on the OTHER
 * row (including the destination-chain typo that makes it vanish from every process's filter) go
 * uncaught by both processes. A destination-selected process serves every route whose
 * `destinationChain` matches its own — the route table is shared across both directions (and every
 * future one), and nothing about which chain is "source" or "destination" is hardcoded here: it is
 * read off each route's own fields.
 *
 * @param destinationChain Wormhole chain id the calling process's wallet delivers to.
 * @param table Route table to filter. Defaults to the deployed one; tests pass a synthetic table so
 *   the destination-keying and second-route behaviour can be driven without real addresses.
 * @returns Every route landing on that chain, each validated, with no two sharing a source key.
 * @throws When any route in `table` carries a blank or malformed address, an unrecognised chain id,
 *   or breaks the table's corridor closure (see `validateRoute` / `assertCorridorClosure`), or when
 *   two served routes share a source (see `assertNoDuplicateSources`).
 */
export function routesFor(destinationChain: ChainId, table: PsmRoute[] = ROUTE_TABLE): PsmRoute[] {
  for (const route of table) {
    validateRoute(route);
  }
  assertCorridorClosure(table);

  const served = table.filter((route) => route.destinationChain === destinationChain);
  assertNoDuplicateSources(served);
  return served;
}

export { ROUTE_TABLE };
