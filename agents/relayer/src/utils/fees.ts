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
 * `FeeOverrides` is validated at runtime, not just declared as a TS union: viem's
 * `estimateFeesPerGas` returns whatever the destination chain's own `fees.estimateFeesPerGas`
 * hook returns, unvalidated, at the boundary this function reads it from
 * (`node_modules/viem/actions/public/estimateFeesPerGas.ts`, the `if (fees !== null) return fees`
 * line) — TypeScript's `EstimateFeesPerGasReturnType<'eip1559'>` on that call is a claim about the
 * shape, not a check of it. A chain object whose hook returns `{ gasPrice }` would otherwise come
 * back through here typed as `maxFeePerGas`/`maxPriorityFeePerGas`, both actually `undefined`, and
 * get handed to `submit` as a well-typed `kind: "eip1559"` `FeeOverrides` carrying no usable fee
 * fields — signing a zero-fee EIP-1559 transaction. The checks below read the actual runtime shape
 * instead of trusting the declared one, and throw rather than pass through anything that is
 * neither.
 *
 * @param chain Destination chain, for the Hydration-specific pricing branch.
 * @param client Public client for that chain.
 * @returns Legacy `gasPrice` when the latest block carries no base fee. Otherwise, for Hydration,
 *   EIP-1559 fields priced off that block plus a guarded priority-fee read; for any other chain,
 *   whichever shape viem's own `estimateFeesPerGas` actually returned.
 * @throws When `chain.id` is not Hydration and neither the returned `gasPrice` nor both
 *   `maxFeePerGas`/`maxPriorityFeePerGas` are `bigint`.
 */
export async function chainFees(chain: Chain, client: PublicClient): Promise<FeeOverrides> {
  const block = await client.getBlock();

  // A zero base fee is unreachable on Hydration today (`MinBaseFeePerGas` is strictly positive —
  // see `chains.ts` and the hydration-runtime skill), but under the general contract a chain
  // reporting `baseFeePerGas: 0n` must not be priced as `maxFeePerGas: 0n`; master treated a falsy
  // base fee as "no base fee" and this keeps that reading.
  if (!block.baseFeePerGas) {
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
