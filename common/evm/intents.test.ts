import assert from "node:assert/strict";
import { test } from "node:test";

import { minOrderWeth } from "./intents";

const E15 = 10n ** 15n;
const base = { cost: 10n ** 12n, minOrderAmount: 10n ** 11n };
const ceiling = 317n * 10n ** 12n; // 0.000317 ETH
/** nBTC at 0.0282 per ETH, the hard floor 20% under it: sat per 1e18 wei. */
const btcFloor = (2_820_000n * 80n) / 100n;

test("an order of the least sum pays out even at the floor", () => {
  const least = minOrderWeth(base, ceiling, btcFloor, 6400n);
  const worst = (w: bigint) => {
    const bridged = ((w - base.cost) / 10n ** 10n) * 10n ** 10n;
    return ((((bridged - ceiling) * 99n) / 100n) * btcFloor) / 10n ** 18n;
  };
  assert.ok(worst(least) >= 6400n);
  assert.ok(least - base.cost < 4n * E15 && least > 3n * E15);
  assert.equal((least - base.cost) % 10n ** 10n, 0n);
});

test("without a route minimum it is the dispatcher's least order: twice the ceiling", () => {
  assert.equal(minOrderWeth(base, ceiling, btcFloor, 0n), base.cost + 2n * ceiling);
});

test("a tiny ceiling leaves the dispatcher's least order plus the ceiling", () => {
  assert.equal(minOrderWeth(base, 10n ** 10n, 0n, 0n), base.cost + 11n * 10n ** 10n);
});

test("no floor cannot promise a route's minimum", () => {
  assert.throws(() => minOrderWeth(base, ceiling, 0n, 6400n));
});
