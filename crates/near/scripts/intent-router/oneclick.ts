/** A 1Click `/v0/quote` response, as far as the signed field set reads it. */
export interface QuoteResponse {
  quote: Record<string, string | number | undefined> & {
    depositAddress?: string;
    amountIn: string;
    amountOut: string;
    minAmountOut: string;
  };
  quoteRequest: Record<string, unknown> & { dry: boolean };
  signature: string;
  timestamp: string;
}

/** Truthy or dropped — the SDK's `x || undefined`, so a `0` or `""` is not signed. */
const or = (v: unknown) => (v ? v : undefined);

/**
 * The fields 1Click signs, exactly as its SDK's `buildSignedQuoteRequest` + `buildSignedQuote` pick
 * them: a fixed whitelist of the request, the quote's amounts, and — for a non-dry quote — its
 * deposit account, deadline and fees, plus the timestamp. What the router's `swap` takes as
 * `quote.signed`; it re-serialises the set and checks 1Click's signature over it.
 *
 * @param r The quote response
 * @returns The signed fields, unset ones omitted
 */
export function signedFields(r: QuoteResponse): Record<string, unknown> {
  const q = r.quoteRequest;
  const quote = r.quote;
  const fields: Record<string, unknown> = {
    dry: q.dry,
    swapType: q.swapType,
    slippageTolerance: q.slippageTolerance,
    originAsset: q.originAsset,
    depositType: q.depositType,
    destinationAsset: q.destinationAsset,
    amount: q.amount,
    refundTo: q.refundTo,
    refundType: q.refundType,
    recipient: q.recipient,
    recipientType: q.recipientType,
    deadline: q.deadline,
    quoteWaitingTimeMs: or(q.quoteWaitingTimeMs),
    referral: or(q.referral),
    virtualChainRecipient: or(q.virtualChainRecipient),
    virtualChainRefundRecipient: or(q.virtualChainRefundRecipient),
    customRecipientMsg: or(q.customRecipientMsg),
    amountIn: quote.amountIn,
    amountInFormatted: quote.amountInFormatted,
    amountInUsd: quote.amountInUsd,
    minAmountIn: quote.minAmountIn,
    amountOut: quote.amountOut,
    amountOutFormatted: quote.amountOutFormatted,
    amountOutUsd: quote.amountOutUsd,
    minAmountOut: quote.minAmountOut,
    ...(q.dry
      ? {}
      : {
          depositAddress: or(quote.depositAddress),
          depositMemo: or(quote.depositMemo),
          // The quote's deadline overrides the request's, as the SDK's spread does.
          deadline: or(quote.deadline),
          timeWhenInactive: or(quote.timeWhenInactive),
          timeEstimate: or(quote.timeEstimate),
          refundFee: or(quote.refundFee),
          withdrawFee: or(quote.withdrawFee),
        }),
    timestamp: r.timestamp,
  };
  // Unset fields are not signed — and the router refuses `null`.
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}
