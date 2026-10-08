import { boot } from "../../boot";
import { WORMHOLE } from "../../chains";
import { privateKeyBase } from "../../config";
import { baseClients } from "../../engine/base";

import { makeApp } from "./app";
import { APP_NAME_BASE, FROM_SEQUENCE_FROM_HYDRATION, RPC_BASE } from "./config";
import { routesFor } from "./routes";

/**
 * Entry point for the process that owns Base's wallet: submits every PSM route landing on Base
 * (today, "redeem" — the facilitator's emitter on Hydration) to the deployed HollarBaseVault.
 *
 * Signs with `privateKeyBase()` (env `PRIVKEY_BASE`), NOT `privateKey()` — see that function's own
 * doc comment in `../../config`. This process is the first PSM one to hold clients for a chain
 * other than Hydration; using the shared `PRIVKEY` here would leave this wallet open to being the
 * same account as the Hydration apps' (`app-ntt`, `app-oracle`, `app-basejump`), which is exactly
 * the isolation `PRIVKEY_BASE` exists to keep.
 *
 * See `hydration.ts` for why this is a separate entry point rather than a runtime selection.
 *
 * The callback passed to `boot` MUST be `async`, and routes are validated BEFORE the key is
 * resolved — see `hydration.ts`'s doc comment for both: a plain arrow evaluating
 * `privateKeyBase()` in argument position throws before `start()` returns a promise at all,
 * bypassing `boot`'s winston "fatal:" logging entirely; and a fresh deploy plausibly has neither
 * `PRIVKEY_BASE` nor the address fill set yet, so the route table is checked first.
 */
boot("psm-base", async () => {
  routesFor(WORMHOLE.base);
  const key = privateKeyBase();
  return makeApp(APP_NAME_BASE, WORMHOLE.base, baseClients, RPC_BASE, key, FROM_SEQUENCE_FROM_HYDRATION);
});
