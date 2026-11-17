import { isAddress, type Address } from "viem";

/**
 * Mainnet addresses. The transceiver is the WETH rail's, shared with the v1 `intent` app; the
 * dispatcher and forwarder are the proxies from deployments/prod/intents-v2.json (steps 001, 002).
 */
const ADDRESSES = {
  /** WormholeTransceiver (WETH) on Hydration — publishes the settlement we subscribe to. */
  transceiver: "0x8acce9CA511d5D7213F8C3f813B8916087cd00ae",
  /** IntentDispatcher proxy on Hydration — the only sender whose transfers are orders. */
  dispatcher: "0x2c967d7e00a18c1c926fd77de733a27c3fdb3f2b",
  /** IntentForwarder proxy on Ethereum — the orders' recipient, and what this calls. */
  forwarder: "0x31ab66509a8a0b5a0fdf33ff4a4297481863035c",
};

export interface IntentV2Route {
  transceiver: Address;
  dispatcher: Address;
  forwarder: Address;
}

/**
 * The deployed intents v2 route.
 *
 * @returns Its three addresses, validated.
 * @throws When one is still unset or malformed.
 */
export function route(): IntentV2Route {
  for (const [name, value] of Object.entries(ADDRESSES)) {
    if (!isAddress(value)) {
      throw new Error(`intent-v2 ${name} is not set — fill it in apps/intent-v2/routes.ts`);
    }
  }
  return ADDRESSES as IntentV2Route;
}
