import { verifyQuoteSignature, type OneClickQuoteResponse } from "@defuse-protocol/one-click-sdk-typescript";

import type { QuoteResponse } from "./oneclick";

const BPS = 10_000n;
const WEI = 10n ** 18n;

/**
 * The router's per-order price check (`floor.rs` `meets_rate`): `minOut` at least `amountIn` at the
 * order's price, less the terms' slippage.
 *
 * @param amountIn ETH in, wei.
 * @param minOut The quote's least output.
 * @param outPerIn The order's price — destination units per 1e18 wei.
 * @param slippageBps The terms' `maxSlippageBps`.
 * @returns Whether the router accepts it.
 */
export function meetsRate(amountIn: bigint, minOut: bigint, outPerIn: bigint, slippageBps: bigint): boolean {
  return minOut * WEI * BPS >= amountIn * outPerIn * (BPS - slippageBps);
}

/**
 * The router's hard floor (`floor.rs` `meets_hard_floor`): `minOut` at least `amountIn` at the terms'
 * `minOutPerIn`.
 *
 * @param amountIn ETH in, wei.
 * @param minOut The quote's least output.
 * @param minOutPerIn The terms' floor — destination units per 1e18 wei.
 * @returns Whether the router accepts it.
 */
export function meetsHardFloor(amountIn: bigint, minOut: bigint, minOutPerIn: bigint): boolean {
  return minOut * WEI >= amountIn * minOutPerIn;
}

/** Why the router would refuse a quote, before anyone pays to ask it. */
export type QuoteCheck =
  | { ok: true }
  | { ok: false; reason: "signature" }
  | { ok: false; reason: "floor"; minOut: bigint; needRate: bigint; needFloor: bigint };

/**
 * Check a quote the way the router's `swap` will: signed by one of its `quote_keys`, and paying at
 * least the order's price less slippage and the terms' hard floor.
 *
 * @param q 1Click's quote.
 * @param order The order's price, and the terms' slippage and floor.
 * @param quoteKeys The router's `quote_keys`.
 * @returns `ok`, or what the router would refuse.
 */
export function checkQuote(
  q: QuoteResponse,
  order: { outPerIn: bigint; maxSlippageBps: bigint; minOutPerIn: bigint },
  quoteKeys: string[],
): QuoteCheck {
  const signed = quoteKeys.some((key) => verifyQuoteSignature(q as unknown as OneClickQuoteResponse, key));
  if (!signed) return { ok: false, reason: "signature" };
  const amountIn = BigInt(q.quote.amountIn);
  const minOut = BigInt(q.quote.minAmountOut);
  if (meetsRate(amountIn, minOut, order.outPerIn, order.maxSlippageBps) && meetsHardFloor(amountIn, minOut, order.minOutPerIn)) {
    return { ok: true };
  }
  const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
  return {
    ok: false,
    reason: "floor",
    minOut,
    needRate: ceil(amountIn * order.outPerIn * (BPS - order.maxSlippageBps), WEI * BPS),
    needFloor: ceil(amountIn * order.minOutPerIn, WEI),
  };
}
