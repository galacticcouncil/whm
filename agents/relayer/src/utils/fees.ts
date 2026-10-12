import type { Chain, PublicClient } from "viem";

import { HYDRATION_EVM_CHAIN_ID } from "../chains";

/**
 * Discriminated rather than a bag of optionals: viem's write params are a union of legacy and
 * EIP-1559 shapes, and spreading a half-set object satisfies neither.
 */
export type FeeOverrides =
  | { kind: "legacy"; gasPrice: bigint }
  | { kind: "eip1559"; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

/**
 * Hydration currently wants no priority fee, and some compatible RPCs do not expose
 * `eth_maxPriorityFeePerGas` at all — so fall back to zero rather than to a library default, which
 * would overpay on every submission.
 */
async function priorityFee(client: PublicClient): Promise<bigint> {
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
 * Fee overrides for a submission to `chain`.
 *
 * Any chain other than Hydration takes viem's `estimateFeesPerGas`, shape-checked because viem
 * passes a chain's own fee hook result through unvalidated.
 *
 * @param chain Destination chain.
 * @param client Public client for that chain.
 * @returns Legacy `gasPrice` when the latest block has no base fee; otherwise EIP-1559 fields for
 *          Hydration, or whichever shape viem's estimate returned for any other chain.
 * @throws When a non-Hydration estimate carries neither fee shape.
 */
export async function chainFees(chain: Chain, client: PublicClient): Promise<FeeOverrides> {
  const block = await client.getBlock();

  if (!block.baseFeePerGas) {
    return { kind: "legacy", gasPrice: await client.getGasPrice() };
  }

  if (chain.id === HYDRATION_EVM_CHAIN_ID) {
    const maxPriorityFeePerGas = await priorityFee(client);
    return {
      kind: "eip1559",
      maxPriorityFeePerGas,
      maxFeePerGas: block.baseFeePerGas * 2n + maxPriorityFeePerGas,
    };
  }

  const fees = (await client.estimateFeesPerGas()) as {
    gasPrice?: unknown;
    maxFeePerGas?: unknown;
    maxPriorityFeePerGas?: unknown;
  };
  if (typeof fees.gasPrice === "bigint") {
    return { kind: "legacy", gasPrice: fees.gasPrice };
  }
  if (typeof fees.maxFeePerGas === "bigint" && typeof fees.maxPriorityFeePerGas === "bigint") {
    return { kind: "eip1559", maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
  }
  throw new Error(`chainFees: ${chain.name} returned no usable fee fields`);
}
