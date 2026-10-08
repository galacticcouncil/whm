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
 * @returns Legacy `gasPrice` when the chain reports no base fee, EIP-1559 fields otherwise, with no
 *   priority fee when the RPC does not report one.
 */
export const hydrationFees: ChainEstimateFeesPerGasFn = async ({ block, client }) => {
  if (!block.baseFeePerGas) {
    return { gasPrice: await getGasPrice(client) };
  }

  const maxPriorityFeePerGas = await priorityFee(client);
  return {
    maxPriorityFeePerGas,
    maxFeePerGas: block.baseFeePerGas * 2n + maxPriorityFeePerGas,
  };
};
