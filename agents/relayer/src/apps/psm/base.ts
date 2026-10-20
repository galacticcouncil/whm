import { boot } from "../../boot";
import { WORMHOLE } from "../../chains";
import { privateKeyBase } from "../../config";
import { baseClients } from "../../clients/base";

import { makeApp } from "./app";
import { APP_NAME_BASE, FROM_SEQUENCE_FROM_HYDRATION, RPC_BASE } from "./config";
import { servedRoutes } from "./routes";

/**
 * The process that owns Base's wallet: every PSM route landing on Base goes to the vault. Signs
 * with `PRIVKEY_BASE`, never `PRIVKEY`, so the Base wallet's funds and key are not a Hydration
 * wallet's. Routes are validated before the key is read, and the callback is `async`, for the
 * reasons in `hydration.ts`.
 */
boot("psm-base", async () => {
  servedRoutes(WORMHOLE.base);
  const key = privateKeyBase();
  return makeApp(APP_NAME_BASE, WORMHOLE.base, baseClients, RPC_BASE, key, FROM_SEQUENCE_FROM_HYDRATION);
});
