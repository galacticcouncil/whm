import assert from "node:assert/strict";
import { test } from "node:test";

import { watch, type WatchInput } from "./watch";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

/** An order forwarded just now, not yet credited, far from the deadline. */
const base: WatchInput = {
  nowMs: NOW,
  deadlineMs: NOW + 24 * 60 * MIN,
  eth: 0n,
  minRefund: 100n,
  maxOrderShortfallBps: 100n,
  order: { seq: "7", amount: 1_000n, forwardedAtMs: NOW, filled: false },
  creditAlertMs: 30 * MIN,
  swapAlertMs: 60 * MIN,
  refundAlertMs: 60 * MIN,
};
const keys = (i: WatchInput) => watch(i).map((w) => w.key);
const at = (sinceForward: number, extra: Partial<WatchInput> = {}): WatchInput => ({
  ...base,
  ...extra,
  order: { ...base.order!, forwardedAtMs: NOW - sinceForward, ...(extra.order ?? {}) },
});

test("an order not credited is raised at 30 min after its forward, not before", () => {
  assert.deepEqual(keys(at(29 * MIN)), []);
  assert.deepEqual(keys(at(30 * MIN)), ["credit:7"]);
  assert.deepEqual(keys(at(30 * MIN, { eth: 989n })), ["credit:7"]);
});

test("credited — within the shortfall — it is not, and waiting to swap is raised at 1 h", () => {
  assert.deepEqual(keys(at(59 * MIN, { eth: 990n })), []);
  const [w] = watch(at(60 * MIN, { eth: 990n, blocked: "Price under the floor: 1Click quotes at least 5, the router needs 6." }));
  assert.equal(w.key, "swap:7");
  assert.match(w.details, /under the floor/);
  assert.deepEqual(w.fields, [
    ["Order", "7"],
    ["In A", "0 ETH"],
  ]);
});

test("a swapped order, or one not yet forwarded, raises nothing", () => {
  assert.deepEqual(keys(at(5 * 60 * MIN, { eth: 990n, order: { seq: "7", amount: 1_000n, filled: true } })), []);
  assert.deepEqual(keys({ ...base, order: { seq: "7", amount: 1_000n, filled: false } }), []);
});

test("ETH in A in the deadline's last hour is a refund coming; past the deadline it is not", () => {
  const near = { order: undefined, eth: 500n };
  assert.deepEqual(keys({ ...base, ...near, deadlineMs: NOW + 61 * MIN }), []);
  assert.deepEqual(keys({ ...base, ...near, deadlineMs: NOW + 60 * MIN }), ["refund"]);
  assert.deepEqual(keys({ ...base, ...near, deadlineMs: NOW - 1 }), []);
  assert.deepEqual(keys({ ...base, order: undefined, eth: 99n, deadlineMs: NOW + 10 * MIN }), []);
});

test("amounts read in ETH", async () => {
  const { eth } = await import("./watch");
  assert.equal(eth(664_816_257_649_152n), "0.000665 ETH");
  assert.equal(eth(10n ** 18n), "1 ETH");
});
