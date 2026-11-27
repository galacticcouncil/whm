import assert from "node:assert/strict";
import { test } from "node:test";

// `alerts.ts` reads the app's config at load; only the account and scan's address show in alerts.
for (const k of ["SCAN_API", "RPC_NEAR", "ROUTER", "NEAR_PRIVKEY", "ONECLICK_KEY"]) process.env[k] ??= "-";
process.env.NEAR_ACCOUNT ??= "relayer.hydration-whm.near";
process.env.SCAN_URL ??= "https://scan.example/";

const PATH = "0xcddd98487cfbe7a7e95c52a9cef24da89af11130a7b887df31b804d59a6fb4ef";

test("every router alert is headed router [action], with its level and details", async () => {
  const { alerts } = await import("./alerts");
  const heads = [
    alerts.quoteKey(["ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc"]),
    alerts.oneClickDown(12 * 60_000, "HTTP 503"),
    alerts.passFailing(11 * 60_000),
    alerts.balanceLow(5n * 10n ** 23n),
    alerts.watched(PATH, { key: "swap:7", action: "waiting to swap", details: "Price under the floor", fields: [["Order", "7"]] }),
  ].map((a) => [a.component, a.action, a.level]);
  assert.deepEqual(heads, [
    ["router", "quote key not accepted", "error"],
    ["router", "1click unreachable", "error"],
    ["router", "no pass completing", "error"],
    ["router", "balance low", "warn"],
    ["router", "waiting to swap", "warn"],
  ]);
});

test("fields read as approved: durations, NEAR, shortened and linked ids", async () => {
  const { alerts } = await import("./alerts");
  assert.deepEqual(alerts.oneClickDown(12 * 60_000, "HTTP 503").fields, [
    ["Failing for", "12min"],
    ["Last error", "HTTP 503"],
  ]);
  assert.deepEqual(alerts.balanceLow(5n * 10n ** 23n).fields, [
    ["Account", "[relayer.hydration-whm.near](https://nearblocks.io/address/relayer.hydration-whm.near)"],
    ["Balance", "0.5 NEAR"],
    ["Floor", "1 NEAR"],
  ]);
  assert.deepEqual(alerts.watched(PATH, { key: "k", action: "a", details: "d", fields: [["Order", "7"]] }).fields, [
    ["Trade", `[0xcddd98…fb4ef](https://scan.example/v2/trade/${PATH})`],
    ["Order", "7"],
  ]);
  assert.deepEqual(alerts.quoteKey(["ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc"]).fields, [
    ["Router keys", "ed25519:reYaWh…tRVifc"],
  ]);
  assert.deepEqual(alerts.quoteKey([]).fields, [["Router keys", "none"]]);
});

test("why a swap waits", async () => {
  const { waiting } = await import("./alerts");
  assert.equal(
    waiting.floor({ ok: false, reason: "floor", minOut: 148_210n, needRate: 152_603n, needFloor: 124_600n }),
    "Price under the floor — 1Click quotes at least 148210, the router needs 152603",
  );
  assert.equal(waiting.quoteFailing("HTTP 503"), "1Click quote failing — HTTP 503");
});
