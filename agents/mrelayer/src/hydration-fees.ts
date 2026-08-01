import { BigNumber, ethers } from "ethers";

type HydrationFeeOverrides = Partial<
  Pick<
    ethers.providers.TransactionRequest,
    "gasPrice" | "maxFeePerGas" | "maxPriorityFeePerGas"
  >
>;

async function getPriorityFeePerGas(
  provider: ethers.providers.JsonRpcProvider
): Promise<BigNumber> {
  try {
    return BigNumber.from(await provider.send("eth_maxPriorityFeePerGas", []));
  } catch (_) {
    // Hydration currently requires no priority fee. Some compatible RPCs do
    // not expose eth_maxPriorityFeePerGas, so do not fall back to ethers v5's
    // hard-coded 1.5 Gwei value.
    return ethers.constants.Zero;
  }
}

export async function getHydrationFeeOverrides(
  provider: ethers.providers.JsonRpcProvider
): Promise<HydrationFeeOverrides> {
  const block = await provider.getBlock("latest");

  if (!block.baseFeePerGas) {
    return { gasPrice: await provider.getGasPrice() };
  }

  const maxPriorityFeePerGas = await getPriorityFeePerGas(provider);
  return {
    maxPriorityFeePerGas,
    maxFeePerGas: block.baseFeePerGas.mul(2).add(maxPriorityFeePerGas),
  };
}
