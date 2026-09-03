import { CHAINS, CHAIN_ID_TO_NAME } from "@certusone/wormhole-sdk";
import { defineChain } from "viem";

/** Wormhole chain ids. relayer-engine's SDK enum predates Hydration, so these are plain numbers. */
export const WORMHOLE = {
  solana: 1,
  ethereum: 2,
  sui: 21,
  base: 30,
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
