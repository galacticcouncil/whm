import assert from "node:assert/strict";
import { test } from "node:test";

import type { Withdrawal } from "./store";

// `alerts.ts` reads the app's config at load; none of what it requires shows in an alert.
for (const k of ["RPC_HYDRATION_WSS", "NEAR_ACCOUNT_ID", "NEAR_PRIVKEY", "SCAN_API"]) process.env[k] ??= "-";

const A = "3f11c7ffa50bd4b7e5a0df078874ae4a9ed4e8f4369b5c914789fe62a219212f";
const TO = "t1RPpso7PVchSGWpGXEmcUHRDuTEux1tkvE";

test("every relayer alert is headed utxo relayer [action], with its level", async () => {
  const { alerts } = await import("./alerts");
  const record: Withdrawal = {
    chain: "zcash",
    sequence: "intent:8upqnEnvJ7AusT6YFt3MEKJdvMgq8UUfRKmWAoZAxJv9:17000",
    account: A,
    address: TO,
    amount: "156427",
    block: "0",
    state: "open",
    createdAt: 0,
    updatedAt: 0,
  };
  const heads = [alerts.passFailing(11 * 60_000, "ECONNREFUSED"), alerts.balanceLow("relayer.hydration-whm.near", 5n * 10n ** 23n), alerts.stuck(record, 1253 * 60_000)].map(
    (a) => [a.component, a.action, a.level],
  );
  assert.deepEqual(heads, [
    ["utxo relayer", "no pass completing", "error"],
    ["utxo relayer", "balance low", "warn"],
    ["utxo relayer", "withdrawal stuck", "warn"],
  ]);
  assert.equal(alerts.stuck(record, 1253 * 60_000).details, "Waiting for the settlement");
  assert.deepEqual(alerts.stuck(record, 1253 * 60_000).fields, [
    ["Open", "20h 53min"],
    ["Record", "zcash:intent:8upqnEn…:17000"],
    ["To", `[t1RPps…1tkvE](https://blockchair.com/zcash/address/${TO})`],
    ["Via", `[3f11c7…9212f](https://nearblocks.io/address/${A})`],
  ]);
});

test("a named NEAR account stays whole; an implicit one is shortened", async () => {
  const { nearAccount } = await import("./alerts");
  assert.equal(nearAccount("relayer.hydration-whm.near"), "[relayer.hydration-whm.near](https://nearblocks.io/address/relayer.hydration-whm.near)");
  assert.equal(nearAccount(A), `[3f11c7…9212f](https://nearblocks.io/address/${A})`);
});

test("a failed withdrawal's incident shows amount in the chain's unit, destination and A", async () => {
  const { incidentFields } = await import("./alerts");
  assert.deepEqual(incidentFields("bitcoin", 7_329n, "bc1qexampleaddressxyz", A), [
    ["Amount", "7329 sat"],
    ["To", "[bc1qex…ssxyz](https://blockchair.com/bitcoin/address/bc1qexampleaddressxyz)"],
    ["Via", `[3f11c7…9212f](https://nearblocks.io/address/${A})`],
  ]);
});
