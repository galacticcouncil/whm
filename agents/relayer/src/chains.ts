import { CHAINS, CHAIN_ID_TO_NAME } from "@certusone/wormhole-sdk";
import { defineChain } from "viem";
import { base as viemBase } from "viem/chains";

/** Wormhole chain ids. relayer-engine's SDK enum predates Hydration, so these are plain numbers. */
export const WORMHOLE = {
  solana: 1,
  ethereum: 2,
  sui: 21,
  base: 30,
  robinhood: 72,
  hydration: 73,
} as const;

/** Hydration's EVM chain id — asserted at startup so a misconfigured RPC fails loudly. */
export const HYDRATION_EVM_CHAIN_ID = 222222;

export const hydration = defineChain({
  id: HYDRATION_EVM_CHAIN_ID,
  name: "Hydration",
  nativeCurrency: { name: "WETH", symbol: "WETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

/** Base's EVM chain id — asserted at startup so a misconfigured RPC fails loudly (see `../engine/base`). */
export const BASE_EVM_CHAIN_ID = viemBase.id;

/**
 * Base, from viem's built-in definition, with one override: `rpcUrls.default.http` emptied out to
 * `[]`, same as `hydration` above.
 *
 * Without that override, `http(rpcUrl)` in `../engine/base` falls back to viem's built-in
 * `https://mainnet.base.org` whenever `rpcUrl` is falsy (`http`'s own source:
 * `const url_ = url || chain?.rpcUrls.default.http[0]`), so `baseClients("")` would silently sign
 * against a real public endpoint instead of failing. `chain?.rpcUrls.default.http[0]` being
 * `undefined` here is what turns that into viem's own `UrlRequiredError`, the same mechanism
 * `hydrationClients("")` already fails by.
 *
 * That protects the factory, not the app: `apps/psm/config.ts` resolves an unset or empty `RPC_BASE`
 * to `https://mainnet.base.org` itself, as it does `RPC_HYDRATION` to a public endpoint, so psm-base
 * started without one still signs against that endpoint.
 */
export const base = defineChain({
  ...viemBase,
  rpcUrls: { default: { http: [] } },
});

/** Robinhood Chain's EVM chain id — asserted at startup so a misconfigured RPC fails loudly. */
export const ROBINHOOD_EVM_CHAIN_ID = 4663;

export const robinhood = defineChain({
  id: ROBINHOOD_EVM_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

/**
 * The EVM chain id behind each Wormhole chain id a PSM process delivers to. `makeApp` checks the
 * clients it is handed against this, so an entry point that pairs the wrong client factory with a
 * destination refuses to start instead of delivering to the wrong chain. A chain gets an entry here
 * together with its entry point.
 */
export const EVM_CHAIN_ID: Record<number, number> = {
  [WORMHOLE.base]: BASE_EVM_CHAIN_ID,
  [WORMHOLE.hydration]: HYDRATION_EVM_CHAIN_ID,
};

/**
 * Teach relayer-engine's bundled `@certusone/wormhole-sdk` about chain 73.
 *
 * The SDK predates Hydration, so `coalesceChainId(73)` returns `undefined`. Everything downstream
 * reads that as `0`, and proto3 omits zero-valued scalars — so `GetSignedVAA` goes out with no
 * `emitter_chain` field at all and the guardian API answers `13 internal server error` for every
 * Hydration sequence. That is why the missed-VAA worker can never recover a chain-73 VAA.
 *
 * `CHAINS` is a plain mutable map, so registering the chain fixes it at the source — no patched
 * dependency to re-apply on upgrade. Call before anything reaches the SDK; `boot()` does.
 *
 * @remarks `isEVMChain(73)` stays false — that reads a separate hardcoded list. Nothing here needs
 *          it, and `engine/emitter.ts` already works around the EVM-only emitter encoding.
 */
export function registerHydration(): void {
  (CHAINS as Record<string, number>).hydration = WORMHOLE.hydration;
  (CHAIN_ID_TO_NAME as Record<number, string>)[WORMHOLE.hydration] = "hydration";
}

/**
 * Teach relayer-engine's bundled `@certusone/wormhole-sdk` about chain 72, for the same reason as
 * {@link registerHydration}: without it the missed-VAA worker sends `GetSignedVAA` with no
 * `emitter_chain` and can never recover a Robinhood VAA. Call before anything reaches the SDK;
 * `boot()` does.
 *
 * @remarks `isEVMChain(72)` stays false, so subscriptions go through `engine/emitter.ts`.
 */
export function registerRobinhood(): void {
  (CHAINS as Record<string, number>).robinhood = WORMHOLE.robinhood;
  (CHAIN_ID_TO_NAME as Record<number, string>)[WORMHOLE.robinhood] = "robinhood";
}
