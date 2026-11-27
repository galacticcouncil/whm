import assert from "node:assert/strict";
import { test } from "node:test";

import { Incidents, type RedisLike } from "./incidents";
import type { Embed, Message } from "./notify";

/** An in-memory stand-in for the few Redis calls incidents make. */
function fakeRedis(): RedisLike {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const set = (k: string) => sets.get(k) ?? sets.set(k, new Set()).get(k)!;
  return {
    get: async (k) => kv.get(k) ?? null,
    set: async (k, v) => kv.set(k, v),
    del: async (k) => (kv.delete(k) ? 1 : 0),
    sadd: async (k, m) => (set(k).has(m) ? 0 : (set(k).add(m), 1)),
    srem: async (k, m) => (set(k).delete(m) ? 1 : 0),
    smembers: async (k) => [...set(k)],
  };
}

function setup(publicUrl?: string) {
  const alerts: Embed[] = [];
  const cleared: string[] = [];
  const quiet = { warn: () => {}, error: () => {} };
  const incidents = new Incidents({
    redis: fakeRedis(),
    prefix: "t",
    app: "router",
    alerter: { alert: (_k, _s, m: Message) => alerts.push(m as Embed), clear: (k) => cleared.push(k) },
    publicUrl,
    maxRedeemsPerHour: 2,
    log: quiet,
    now: () => 1_000,
  });
  return { incidents, alerts, cleared };
}

const tokenOf = (alert: Embed) => new URL(alert.url!).searchParams.get("token")!;

test("a failure opens one incident, alerted once as an error with a reprocess link", async () => {
  const { incidents, alerts } = setup("https://bot.example/");
  await incidents.open("0xabc", "relay refused");
  await incidents.open("0xabc", "again");
  assert.deepEqual(await incidents.get("0xabc"), { id: "0xabc", reason: "relay refused", at: 1_000 });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, "error");
  assert.equal(alerts[0].description, "relay refused");
  assert.match(alerts[0].url!, /^https:\/\/bot\.example\/reprocess\/0xabc\?token=/);
  assert.deepEqual((await incidents.list()).map((i) => i.id), ["0xabc"]);
});

test("its token reprocesses it once; a wrong or spent token does nothing", async () => {
  const { incidents, alerts, cleared } = setup("https://bot.example");
  await incidents.open("0xabc", "relay refused");
  const token = tokenOf(alerts[0]);
  assert.equal(await incidents.redeem("0xabc", "wrong"), "unknown");
  assert.ok(await incidents.get("0xabc"));
  assert.equal(await incidents.redeem("0xabc", token), "ok");
  assert.equal(await incidents.get("0xabc"), undefined);
  assert.deepEqual(cleared, ["incident:0xabc"]);
  assert.equal(await incidents.redeem("0xabc", token), "unknown");
});

test("redeems are capped per hour across incidents", async () => {
  const { incidents, alerts } = setup("https://bot.example");
  for (const id of ["a", "b", "c"]) await incidents.open(id, "x");
  const [ta, tb, tc] = alerts.map(tokenOf);
  assert.equal(await incidents.redeem("a", ta), "ok");
  assert.equal(await incidents.redeem("b", tb), "ok");
  assert.equal(await incidents.redeem("c", tc), "limited");
  assert.ok(await incidents.get("c"));
});

test("without a public URL the alert has no link", async () => {
  const { incidents, alerts } = setup();
  await incidents.open("0xabc", "relay refused");
  assert.equal(alerts[0].url, undefined);
});
