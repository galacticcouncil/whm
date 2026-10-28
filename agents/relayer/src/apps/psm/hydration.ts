import { boot } from "../../boot";
import { WORMHOLE } from "../../chains";
import { privateKey } from "../../config";
import { hydrationClients } from "../../engine/hydration";

import { makeApp } from "./app";
import { APP_NAME_HYDRATION, FROM_SEQUENCE_FROM_BASE, psmWebhook, RPC_HYDRATION } from "./config";
import { servedRoutes } from "./routes";

/**
 * The process that owns Hydration's wallet: every PSM route landing on Hydration goes to the
 * facilitator. Signs with `PRIVKEY`, which must hold a different key from the other Hydration
 * apps'. Routes are validated before the key is read, so a blank table is the first error on a
 * fresh deploy, and the callback is `async` so a throw before `makeApp` rejects instead of
 * escaping `boot`'s catch.
 */
boot("psm-hydration", async () => {
  servedRoutes(WORMHOLE.hydration);
  const key = privateKey();
  psmWebhook();
  return makeApp(APP_NAME_HYDRATION, WORMHOLE.hydration, hydrationClients, RPC_HYDRATION, key, FROM_SEQUENCE_FROM_BASE);
});
