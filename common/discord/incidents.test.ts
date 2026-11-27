import assert from "node:assert/strict";
import { test } from "node:test";

import { Incidents, summary, type RedisLike } from "./incidents";
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

/** The reprocess link's address, from the alert's `Reprocess` field. */
const urlOf = (alert: Embed) => /\((https:[^)]+)\)/.exec(alert.fields!.find(([l]) => l === "Reprocess")![1])?.[1];
const tokenOf = (alert: Embed) => new URL(urlOf(alert)!).searchParams.get("token")!;

test("a failure opens one incident, alerted once as an error with a reprocess link", async () => {
  const { incidents, alerts } = setup("https://bot.example/");
  await incidents.open("0xabc", "relay refused", [["Trade", "0xabc"]]);
  await incidents.open("0xabc", "again");
  assert.deepEqual(await incidents.get("0xabc"), { id: "0xabc", reason: "relay refused", at: 1_000 });
  assert.equal(alerts.length, 1);
  const [a] = alerts;
  assert.deepEqual([a.component, a.action, a.level, a.details], ["router", "stopped", "error", "Relay refused"]);
  assert.deepEqual(a.fields![0], ["Trade", "0xabc"]);
  assert.match(urlOf(a)!, /^https:\/\/bot\.example\/reprocess\/0xabc\?token=/);
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
  assert.equal(urlOf(alerts[0]), undefined);
});

test("a contract's refusal is summarised by its name; anything else is cut short", () => {
  const receipt =
    'settle: sign — settle tx: nothing signed — [{"Failure":{"ActionError":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: BelowRouteMinimum"}}}}}]';
  assert.equal(summary(receipt), "Settle: sign refused by the contract — BelowRouteMinimum");
  assert.equal(summary("relay refused"), "Relay refused");
  assert.equal(summary("x".repeat(400)).length, 300);
});
