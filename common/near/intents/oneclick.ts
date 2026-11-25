/** 1Click Swap API (1CS). */
export const ONE_CLICK_API = "https://1click.chaindefuser.com";

/** A standing pass-through: its deposit address on a chain, and the 1Click account behind it. */
export interface PassThrough {
  /** Where to deposit, on the requested chain. */
  address: string;
  /** 1Click's intents account the address credits, before forwarding. */
  internal: string;
}

/**
 * A reusable 1CS deposit address that forwards whatever arrives, as itself, to an intents account:
 * a standing `ANY_INPUT` quote, `1cs_v1:any` → `1cs_v1:original`, with the account as recipient and
 * refund. Every deposit lands on 1Click's account for the quote first and is forwarded within
 * seconds; the chain's bridge takes its usual time to see the deposit.
 *
 * @param apiKey The 1Click partner key — standing quotes need one
 * @param account The intents account to forward to
 * @param chain The chain to deposit on, as 1CS names it (`eth`, `base`, …)
 * @returns The address on `chain`, and 1Click's account behind it
 * @throws When 1CS refuses the quote, or names no address on `chain`
 */
export async function passThrough(apiKey: string, account: string, chain = "eth"): Promise<PassThrough> {
  const res = await fetch(`${ONE_CLICK_API}/v0/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      dry: false,
      swapType: "ANY_INPUT",
      originAsset: "1cs_v1:any",
      depositType: "INTENTS",
      destinationAsset: "1cs_v1:original",
      amount: "0",
      slippageTolerance: 50,
      recipient: account,
      recipientType: "INTENTS",
      refundTo: account,
      refundType: "INTENTS",
      // The deadline 1CS's docs give for a standing address.
      deadline: "2038-01-01T00:00:00.000Z",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as {
    quote?: { depositAddress: string; chainDepositAddresses?: { blockchain: string; address: string }[] };
  };
  if (!res.ok || !body.quote) throw new Error(`1cs ${res.status}: ${JSON.stringify(body)}`);
  const address = body.quote.chainDepositAddresses?.find((c) => c.blockchain === chain)?.address;
  if (!address) throw new Error(`1cs names no ${chain} address: ${JSON.stringify(body.quote)}`);
  return { address, internal: body.quote.depositAddress };
}
