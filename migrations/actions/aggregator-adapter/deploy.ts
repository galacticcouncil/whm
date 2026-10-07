import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import aggregatorAdapterJson from "../../../contracts/out/AggregatorAdapter.sol/AggregatorAdapter.json";

export type DeployParams = WalletContext & {
  feed: `0x${string}`;
};

export type DeployResult = {
  address: string;
  feed: string;
};

/**
 * Deploy an immutable AggregatorAdapter (no proxy, no owner).
 *
 * @param params - wallet context and the answer-only feed it reads (e.g. Hydration's EMA precompile)
 * @returns the adapter address and the feed it was bound to
 */
export async function deploy(params: DeployParams): Promise<DeployResult> {
  const { publicClient, walletClient, feed } = params;
  const { abi, bytecode } = aggregatorAdapterJson as ifs.ContractArtifact;

  const hash = await walletClient.deployContract({
    abi,
    bytecode: bytecode.object,
    args: [feed],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error("AggregatorAdapter deployment failed — no contract address.");
  }

  return {
    address: receipt.contractAddress,
    feed,
  };
}
