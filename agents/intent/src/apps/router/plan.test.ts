import assert from "node:assert/strict";
import { test } from "node:test";

import { plan, type PlanInput } from "./plan";

const NOW = 1_800_000_000_000;
const ORDER = { seq: "7", amount: 1_000n, publishedAtMs: NOW - 60_000 };

/** Before the deadline, the newest order priced and credited, nothing bought yet. */
const base: PlanInput = {
  nowMs: NOW,
  deadlineMs: NOW + 86_400_000,
  maxFillMultiplier: 2n,
  minDelivery: 500n,
  eth: 1_000n,
  dest: 0n,
  order: ORDER,
  filled: new Set(),
  priceValidityMs: 3_600_000,
  maxOrderShortfallBps: 100n,
  minRefund: 100n,
};

test("swaps A's whole ETH once the order has landed", () => {
  assert.deepEqual(plan(base), { kind: "swap", seq: "7", amount: 1_000n });
});

test("caps the fill at maxFillMultiplier × the order", () => {
  assert.deepEqual(plan({ ...base, eth: 5_000n }), { kind: "swap", seq: "7", amount: 2_000n });
});

test("waits for POA's credit — within the shortfall counts, below it does not", () => {
  assert.equal(plan({ ...base, eth: 990n }).kind, "swap");
  assert.equal(plan({ ...base, eth: 989n }).kind, "wait");
  assert.equal(plan({ ...base, eth: 0n }).kind, "wait");
});

test("does not swap an order past its price, or one already filled", () => {
  assert.equal(plan({ ...base, order: { ...ORDER, publishedAtMs: NOW - 3_600_000 } }).kind, "wait");
  assert.equal(plan({ ...base, filled: new Set(["7"]) }).kind, "wait");
  assert.equal(plan({ ...base, order: undefined }).kind, "wait");
});

test("delivers from minDelivery before the deadline", () => {
  const bought = { ...base, eth: 0n, order: undefined };
  assert.equal(plan({ ...bought, dest: 499n }).kind, "wait");
  assert.equal(plan({ ...bought, dest: 500n }).kind, "deliver");
});

test("a priced order is swapped before a delivery", () => {
  assert.equal(plan({ ...base, dest: 500n }).kind, "swap");
});

test("after the deadline: deliver any output, then refund, then drop", () => {
  const past = { ...base, nowMs: base.deadlineMs + 1, order: undefined };
  assert.equal(plan({ ...past, dest: 1n }).kind, "deliver");
  assert.equal(plan({ ...past, dest: 0n, eth: 100n }).kind, "refund");
  assert.equal(plan({ ...past, dest: 0n, eth: 99n }).kind, "drop");
  assert.equal(plan({ ...past, dest: 0n, eth: 0n }).kind, "drop");
});
