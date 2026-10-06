import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import chainlinkAdapterJson from "../../../contracts/out/ChainlinkAdapter.sol/ChainlinkAdapter.json";

export type DeployParams = WalletContext & {
  feed: `0x${string}`;
  maxAge: bigint;
};

export type DeployResult = {
  address: string;
  feed: string;
  maxAge: string;
};

/**
 * Deploy an immutable ChainlinkAdapter (no proxy, no owner).
 *
 * @param params - wallet context, the Chainlink feed proxy and the max round age in seconds (0 = off)
 * @returns the adapter address and the values it was bound to
 */
export async function deploy(params: DeployParams): Promise<DeployResult> {
  const { publicClient, walletClient, feed, maxAge } = params;
  const { abi, bytecode } = chainlinkAdapterJson as ifs.ContractArtifact;

  const hash = await walletClient.deployContract({
    abi,
    bytecode: bytecode.object,
    args: [feed, maxAge],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error("ChainlinkAdapter deployment failed — no contract address.");
  }

  return {
    address: receipt.contractAddress,
    feed,
    maxAge: maxAge.toString(),
  };
}
