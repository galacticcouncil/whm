import assert from "node:assert/strict";
import { test } from "node:test";

import type { Terms } from "./terms";
import { delivery, routeFor, type UtxoRoute } from "./utxo";

const ZEC = "nep141:zec.omft.near";
const ROUTE: UtxoRoute = {
  withdraw: "withdraw-zec.hydration-whm.near",
  path_prefix: "zcash:v1:",
  address_prefixes: ["t1", "t3"],
  min_amount: "100000",
};
const t: Terms = {
  maxSlippageBps: 300n,
  maxFillMultiplier: 2n,
  minOutPerIn: 0n,
  minDelivery: 1n,
  deadlineMs: 0,
  recipientKind: 0,
  destinationAsset: ZEC,
  recipient: "t1KPVSRgnFHPBWMJLC7taJioN6m5Q6jVBma",
};

test("a transparent address of a routed token takes the route", () => {
  assert.equal(routeFor(t, { [ZEC]: ROUTE }), ROUTE);
  assert.equal(routeFor({ ...t, recipient: "t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd" }, { [ZEC]: ROUTE }), ROUTE);
});

test("anything else stays on POA", () => {
  assert.equal(routeFor(t, {}), undefined);
  assert.equal(routeFor({ ...t, recipient: "zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly" }, { [ZEC]: ROUTE }), undefined);
  assert.equal(routeFor({ ...t, recipientKind: 1, recipient: "t1x.near" }, { [ZEC]: ROUTE }), undefined);
  assert.equal(routeFor({ ...t, destinationAsset: "nep141:wrap.near" }, { [ZEC]: ROUTE }), undefined);
});

test("the router delivers a transfer, native NEAR or a routed withdrawal — from the route's minimum", () => {
  const routes = { [ZEC]: ROUTE };
  assert.deepEqual(delivery(t, routes), { deliverable: true, minPayout: 100_000n });
  assert.deepEqual(delivery({ ...t, recipientKind: 1, recipient: "alice.near" }, routes), { deliverable: true, minPayout: 1n });
  assert.deepEqual(delivery({ ...t, destinationAsset: "nep141:wrap.near", recipient: "alice.near" }, routes), { deliverable: true, minPayout: 1n });
  assert.deepEqual(delivery(t, {}), { deliverable: false, minPayout: 1n });
});
