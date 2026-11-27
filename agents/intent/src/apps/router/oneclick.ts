import { config } from "./config";
import { Refused } from "./types";

const ONECLICK_API = "https://1click.chaindefuser.com";

/** A 1Click `/v0/quote` response, as far as the signed field set reads it. */
export interface QuoteResponse {
  quote: Record<string, string | number | undefined> & {
    depositAddress?: string;
    amountIn: string;
    minAmountOut: string;
  };
  quoteRequest: Record<string, unknown> & { dry: boolean };
  signature: string;
  timestamp: string;
}

/**
 * Whether 1Click is answering: since when every call has failed without an answer — a timeout, a
 * 5xx, a 429 — and the last such failure. A 4xx is an answer; any answer clears it.
 */
export const oneClickHealth: { failingSince?: number; lastError?: string } = {};

/**
 * A 1Click call with the partner key.
 *
 * @param path The endpoint.
 * @param body JSON to POST.
 * @returns The JSON response.
 * @throws On a non-2xx — `Refused` on a 4xx other than 429, which no resend changes.
 */
async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${ONECLICK_API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": config.oneClickKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    unanswered(`1Click ${path}: ${(e as Error).message}`);
    throw e;
  }
  const text = await res.text();
  if (!res.ok) {
    const message = `1Click ${path}: HTTP ${res.status} ${text.slice(0, 400)}`;
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      answered();
      throw new Refused(message);
    }
    unanswered(message);
    throw new Error(message);
  }
  answered();
  return JSON.parse(text) as T;
}

/** 1Click answered. */
function answered(): void {
  oneClickHealth.failingSince = undefined;
  oneClickHealth.lastError = undefined;
}

/**
 * 1Click did not answer.
 *
 * @param error What happened.
 */
function unanswered(error: string): void {
  oneClickHealth.failingSince ??= Date.now();
  oneClickHealth.lastError = error;
}

/**
 * An executable quote swapping `amount` of `origin` into `destination`, deposited from, paid to and
 * refunded to `A` inside `intents.near` — the only shape the router accepts.
 *
 * @param q What to swap, for whom, and the quote's slippage and deadline.
 * @returns 1Click's quote.
 */
export function quote(q: {
  account: string;
  origin: string;
  destination: string;
  amount: bigint;
  slippageBps: number;
  deadlineMs: number;
}): Promise<QuoteResponse> {
  return post<QuoteResponse>("/v0/quote", {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: q.slippageBps,
    originAsset: q.origin,
    depositType: "INTENTS",
    destinationAsset: q.destination,
    amount: q.amount.toString(),
    refundTo: q.account,
    refundType: "INTENTS",
    recipient: q.account,
    recipientType: "INTENTS",
    deadline: new Date(q.deadlineMs).toISOString(),
  });
}

/**
 * Submit the router's signed swap — 1Click's solvers trade it and pay the output back to `A`.
 *
 * @param signedData The `intent_signed` event's `signed_data`.
 * @returns The intent's hash.
 */
export function submitIntent(signedData: unknown): Promise<{ intentHash: string }> {
  return post("/v0/submit-intent", { type: "swap_transfer", signedData });
}

/** Truthy or dropped — the SDK's `x || undefined`, so a `0` or `""` is not signed. */
const or = (v: unknown) => (v ? v : undefined);

/**
 * The fields 1Click signs, exactly as its SDK's `buildSignedQuoteRequest` + `buildSignedQuote` pick
 * them — what the router's `swap` takes as `quote.signed`, re-serialises and checks the signature
 * over.
 *
 * @param r The quote response.
 * @returns The signed fields, unset ones omitted.
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
