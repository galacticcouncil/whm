import type { ChainEstimateFeesPerGasFn, Client } from "viem";
import { getGasPrice } from "viem/actions";

/**
 * Hydration currently wants no priority fee, and some compatible RPCs do not expose
 * `eth_maxPriorityFeePerGas` at all — so fall back to zero rather than to a library default, which
 * would overpay on every submission.
 */
async function priorityFee(client: Client): Promise<bigint> {
  try {
    const hex = await client.request({
      method: "eth_maxPriorityFeePerGas" as never,
      params: [] as never,
    });
    return BigInt(hex as string);
  } catch {
    return 0n;
  }
}

/**
 * Hydration's fee estimator. Wired onto the `hydration` chain definition in `../chains` via viem's
 * `fees.estimateFeesPerGas` hook, rather than passed around by callers. That is what makes it
 * inseparable from the chain it prices: any client built against `hydration` gets this pricing, and
 * nothing else can.
 *
 * Keyed on `type`, not on the block alone, and that is load-bearing. viem decides legacy vs
 * EIP-1559 once per client and caches it (`eip1559NetworkCache`, keyed by `client.uid`) whenever the
 * caller does not set an explicit fee field, which a long-lived process's client never does. A
 * relayer builds its client once at startup, so that cached decision can outlive the block state it
 * was made from: if Hydration's `baseFeePerGas` presence flips after the first submission, viem's
 * `type` argument here can disagree with what the current block reports. Returning a shape that
 * matches the current block instead of `type` would hand viem a `gasPrice`-only object while it
 * expects EIP-1559 fields (or vice versa). It reads the missing field as undefined and signs a
 * half-set transaction instead of erroring, which a node then rejects for a reason the queue cannot
 * distinguish from a routine retry. Honouring `type` keeps every submission internally consistent
 * with viem's own cached decision; the null branch below is what turns a real disagreement into a
 * loud failure instead of a malformed transaction.
 *
 * @returns `gasPrice` when `type` is legacy, regardless of the current block. EIP-1559 fields when
 *   it is not and the block carries a base fee. `null` when it is not and the block carries no base
 *   fee at all: signals viem to fall through to its own default, which throws
 *   `Eip1559FeesNotSupportedError` rather than sign a transaction with an undefined fee field.
 */
export const hydrationFees: ChainEstimateFeesPerGasFn = async ({ block, client, type }) => {
  if (type === "legacy") {
    return { gasPrice: await getGasPrice(client) };
  }

  if (!block.baseFeePerGas) {
    return null;
  }

  const maxPriorityFeePerGas = await priorityFee(client);
  return {
    maxPriorityFeePerGas,
    maxFeePerGas: block.baseFeePerGas * 2n + maxPriorityFeePerGas,
  };
};
