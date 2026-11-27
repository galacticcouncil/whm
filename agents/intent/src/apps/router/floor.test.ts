import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { hashQuote, quoteHash, type OneClickQuoteResponse } from "@defuse-protocol/one-click-sdk-typescript";

import { checkQuote, meetsHardFloor, meetsRate } from "./floor";
import type { QuoteResponse } from "./oneclick";

/** A quote 1Click signed — dry, 0.001 ETH → ZEC, minAmountOut 223552. */
const quote = JSON.parse(readFileSync(new URL("../../../test/quote.fixture.json", import.meta.url), "utf8")) as QuoteResponse;
const KEY = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";
const OTHER = "ed25519:11111111111111111111111111111111";

test("the rate check matches floor.rs", () => {
  const e15 = 10n ** 15n;
  assert.ok(meetsRate(e15, 189_133n, 180_000_000n, 0n));
  assert.ok(meetsRate(e15, 180_000n, 180_000_000n, 0n));
  assert.ok(!meetsRate(e15, 179_999n, 180_000_000n, 0n));
  assert.ok(meetsRate(e15, 188_100n, 190_000_000n, 100n));
  assert.ok(!meetsRate(e15, 188_099n, 190_000_000n, 100n));
  const rate = 1_000n * 10n ** 24n;
  assert.ok(meetsRate(10n ** 18n, rate, rate, 0n));
  assert.ok(!meetsRate(10n ** 18n, rate - 1n, rate, 0n));
});

test("the hard floor matches floor.rs", () => {
  assert.ok(meetsHardFloor(10n ** 15n, 150_000n, 150_000_000n));
  assert.ok(!meetsHardFloor(10n ** 15n, 149_999n, 150_000_000n));
});

test("a quote signed by a router key at the order's price passes", () => {
  // 223552 per 0.001 ETH is 223.552M per ETH: the order's price at 3% slippage and a 20% floor.
  const order = { outPerIn: 230_000_000n, maxSlippageBps: 300n, minOutPerIn: 184_000_000n };
  assert.deepEqual(checkQuote(quote, order, [KEY]), { ok: true });
  assert.deepEqual(checkQuote(quote, order, [OTHER, KEY]), { ok: true });
});

test("a quote no router key signed is refused before signing", () => {
  const order = { outPerIn: 230_000_000n, maxSlippageBps: 300n, minOutPerIn: 0n };
  assert.deepEqual(checkQuote(quote, order, [OTHER]), { ok: false, reason: "signature" });
  assert.deepEqual(checkQuote(quote, order, []), { ok: false, reason: "signature" });
});

test("a quote under the order's price or the hard floor says what it needed", () => {
  const underRate = checkQuote(quote, { outPerIn: 240_000_000n, maxSlippageBps: 300n, minOutPerIn: 0n }, [KEY]);
  assert.deepEqual(underRate, { ok: false, reason: "floor", minOut: 223_552n, needRate: 232_800n, needFloor: 0n });
  const underFloor = checkQuote(quote, { outPerIn: 0n, maxSlippageBps: 0n, minOutPerIn: 223_553_000n }, [KEY]);
  assert.deepEqual(underFloor, { ok: false, reason: "floor", minOut: 223_552n, needRate: 0n, needFloor: 223_553n });
});

test("a tampered quote no longer verifies", () => {
  const tampered = { ...quote, quote: { ...quote.quote, minAmountOut: "999999999" } } as QuoteResponse;
  const order = { outPerIn: 0n, maxSlippageBps: 0n, minOutPerIn: 0n };
  assert.deepEqual(checkQuote(tampered, order, [KEY]), { ok: false, reason: "signature" });
});

test("on a non-dry quote, the SDK verifies exactly the fields the bot hands the router", async () => {
  // `oneclick.ts` reads the app's config at load; none of it matters to `signedFields`.
  for (const k of ["SCAN_API", "RPC_NEAR", "ROUTER", "NEAR_ACCOUNT", "NEAR_PRIVKEY", "ONECLICK_KEY"]) process.env[k] ??= "-";
  const { signedFields } = await import("./oneclick");
  const nonDry = {
    ...quote,
    quoteRequest: { ...quote.quoteRequest, dry: false },
    quote: { ...quote.quote, depositAddress: "0xbb90de6070f7ca255b6fa7de671942e575308211", timeWhenInactive: "2026-11-27T13:10:00.000Z" },
  } as QuoteResponse;
  const { timestamp, ...fields } = signedFields(nonDry);
  const sdk = quoteHash(nonDry as unknown as OneClickQuoteResponse);
  assert.equal(hashQuote(fields as never, {} as never, timestamp as string), sdk);
});
