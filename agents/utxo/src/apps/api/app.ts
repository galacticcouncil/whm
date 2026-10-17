import { JsonRpcProvider } from "near-api-js";

import { banner } from "../../banner";
import { CHAINS } from "../../chains";
import log from "../../logger";
import { Deriver } from "../../near/derive";
import { boot, serve } from "../../server";

import { APP_NAME, RPC_NEAR } from "./config";
import { routes } from "./routes";

/**
 * Which NEAR account a destination address withdraws through — what the SDK hands the coin's
 * emitter. Stateless, read-only, no keys: two NEAR views per new address, cached after.
 */
async function start(): Promise<void> {
  banner(APP_NAME);
  const provider = new JsonRpcProvider({ url: RPC_NEAR });

  const derivers: Record<string, Deriver> = {};
  for (const chain of Object.values(CHAINS)) {
    derivers[chain.name] = await Deriver.create(provider, chain);
    log.info(`  ${chain.name}: ${chain.contract} (signer ${derivers[chain.name].params.mpc_signer})`);
  }

  await serve({
    name: APP_NAME,
    routes: routes(derivers),
    status: () => ({ chains: Object.fromEntries(Object.values(CHAINS).map((c) => [c.name, c.contract])) }),
  });
}

boot(APP_NAME, start);
