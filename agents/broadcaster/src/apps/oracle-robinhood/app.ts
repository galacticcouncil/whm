import { isAddressEqual, zeroAddress } from "viem";

import { wallet } from "@whm/common/evm";

import { boot } from "../../loop.js";
import { createEvmBroadcaster, type EvmFeed } from "../../evm/broadcaster.js";
import { roundWatch } from "../../evm/chainlink.js";
import { signingKey } from "../../evm/signer.js";
import { marketAge } from "../../evm/staleness.js";
import type { Broadcaster } from "../../types.js";

import { RPC } from "./config.js";
import { CHAIN_ID, ROUTES, STALE_AFTER } from "./routes.js";

/**
 * The EVM oracle broadcaster, with every read also checking the Chainlink round behind the source.
 *
 * @returns The broadcaster.
 * @throws When a route still carries the placeholder emitter.
 */
function build(): Broadcaster {
  for (const route of ROUTES) {
    if (isAddressEqual(route.emitter, zeroAddress)) {
      throw new Error(`[${route.label}] emitter unset — fill it from deployments/prod/oracle-relay-robinhood.json`);
    }
  }

  const evm = wallet.getWallet(RPC, CHAIN_ID, signingKey());
  const base = createEvmBroadcaster({ name: "oracle-robinhood", wallet: evm, routes: ROUTES });
  // SPY is a US equity: no rounds outside 24/5 hours, so age counts open-market time only.
  const checkRound = roundWatch(evm.publicClient, STALE_AFTER, marketAge);

  return {
    ...base,
    async read(feed) {
      await checkRound(feed as EvmFeed);
      return base.read(feed);
    },
  };
}

boot(build);
