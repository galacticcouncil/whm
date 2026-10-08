import { boot } from "../../boot";
import { WORMHOLE } from "../../chains";
import { privateKey } from "../../config";
import { hydrationClients } from "../../engine/hydration";

import { makeApp } from "./app";
import { APP_NAME_HYDRATION, FROM_SEQUENCE_FROM_BASE, RPC_HYDRATION } from "./config";
import { routesFor } from "./routes";

/**
 * Entry point for the process that owns Hydration's wallet: submits every PSM route landing on
 * Hydration (today, "mint" — the vault's emitter on Base) to the deployed
 * HollarBaseFacilitator.
 *
 * Signs with `privateKey()` (env `PRIVKEY`) — the same name `ntt` and `oracle` already use for
 * their own Hydration-destination wallets. That is deliberate, not an oversight: four separate
 * processes write to Hydration (this one, `app-ntt`, `app-oracle`, `app-basejump`), and each MUST
 * get its own `PRIVKEY` value at deploy time — see the warning on `app-psm-hydration` in
 * `stack.yml`. Sharing a value across any two of them would put them on the same nonce lane.
 *
 * A separate entry point per destination, rather than one `psm/app.ts` selecting between them at
 * runtime, follows `../../boot`'s own rule: "each app is its own entry point and its own
 * container ... `dist/<app>/app.js` is the app", so nothing here can be started against the wrong
 * wallet by a missing or wrong env var. `ntt` and `oracle` never needed a second entry point
 * because every one of their routes already lands on this same chain; PSM is the first app with
 * more than one destination, so it is the first to need more than one entry file per app.
 *
 * The callback passed to `boot` MUST be `async`, matching `ntt`/`oracle` — not a plain arrow that
 * merely returns `makeApp(...)`'s promise. `boot` catches via `start().catch(...)`, which only
 * ever sees a REJECTION, not a SYNCHRONOUS throw: a plain arrow evaluates every argument
 * (including `privateKey()`) before `makeApp` is even called, so a throw there escapes `start()`
 * itself as an uncaught exception, before any promise exists for `.catch` to attach to — the
 * process dies with a raw stack trace and zero "fatal:" lines through winston. Wrapping the body
 * in `async` is what turns that synchronous throw back into a rejection `boot` can catch.
 *
 * Routes are validated BEFORE the key is resolved, for the same reason in miniature: a fresh
 * deploy plausibly has neither the address fill nor the signing key set yet, and the blank route
 * table is the more fundamental problem — an operator who fixes "missing PRIVKEY" first would just
 * hit the blank-route error on the very next boot anyway. Checking the route table first means the
 * one error that actually shows up first is the one worth acting on first.
 */
boot("psm-hydration", async () => {
  routesFor(WORMHOLE.hydration);
  const key = privateKey();
  return makeApp(APP_NAME_HYDRATION, WORMHOLE.hydration, hydrationClients, RPC_HYDRATION, key, FROM_SEQUENCE_FROM_BASE);
});
