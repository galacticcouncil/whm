import { isAddressEqual, zeroAddress } from "viem";

import { wallet } from "@whm/common/evm";

import { boot } from "../../loop.js";
import { createEvmBroadcaster } from "../../evm/broadcaster.js";
import { signingKey } from "../../evm/signer.js";
import type { Broadcaster } from "../../types.js";

import { RPC } from "./config.js";
import { CHAIN_ID, ROUTES } from "./routes.js";

/**
 * The EVM oracle broadcaster on Hydration.
 *
 * @returns The broadcaster.
 * @throws When a route still carries the placeholder emitter.
 */
function build(): Broadcaster {
  for (const route of ROUTES) {
    if (isAddressEqual(route.emitter, zeroAddress)) {
      throw new Error(`[${route.label}] emitter unset — fill it from deployments/prod/oracle-relay-hydration.json`);
    }
  }

  return createEvmBroadcaster({
    name: "oracle-hydration",
    wallet: wallet.getWallet(RPC, CHAIN_ID, signingKey()),
    routes: ROUTES,
  });
}

boot(build);
