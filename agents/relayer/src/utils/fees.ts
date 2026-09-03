import type { Chain, PublicClient } from "viem";
import { getGasPrice } from "viem/actions";

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
 * Hydration is EIP-1559 by construction, not by convention: `pallet-dynamic-evm-fee`
 * (`pallets/dynamic-evm-fee/src/lib.rs` in `galacticcouncil/hydration-node`) recomputes
 * `BaseFeePerGas` in `on_initialize` every block and is registered as the runtime's
 * `FeeCalculator` (`runtime/hydradx/src/evm/mod.rs`), so a Hydration block never comes back with
 * `baseFeePerGas` absent — there is no runtime state that produces the legacy branch below on
 * Hydration today, short of a runtime upgrade that removes that pallet. The chain also charges
 * whatever tip a caller includes but requires none, so a zero priority fee is both correct and
 * the cheapest submission; some compatible RPCs do not implement `eth_maxPriorityFeePerGas` at
 * all, which is why `priorityFee` above treats a failed read as "no tip" rather than an error.
 *
 * The legacy branch stays in this function for the general contract — any other chain this
 * relayer submits to may not carry a base fee — rather than as a code path Hydration is ever
 * expected to take.
 *
 * @param chain Destination chain, for the Hydration-specific pricing branch.
 * @param client Public client for that chain.
 * @returns Legacy `gasPrice` when the latest block carries no base fee. Otherwise, for Hydration,
 *   EIP-1559 fields priced off that block plus a guarded priority-fee read; for any other chain,
 *   viem's own `estimateFeesPerGas`.
 */
export async function chainFees(chain: Chain, client: PublicClient): Promise<FeeOverrides> {
  const block = await client.getBlock();

  if (block.baseFeePerGas === null) {
    return { kind: "legacy", gasPrice: await getGasPrice(client) };
  }

  if (chain.id === HYDRATION_EVM_CHAIN_ID) {
    const maxPriorityFeePerGas = await priorityFee(client);
    return {
      kind: "eip1559",
      maxPriorityFeePerGas,
      maxFeePerGas: block.baseFeePerGas * 2n + maxPriorityFeePerGas,
    };
  }

  const fees = await client.estimateFeesPerGas();
  return {
    kind: "eip1559",
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  };
}
