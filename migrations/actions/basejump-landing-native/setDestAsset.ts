import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import basejumpLandingNativeJson from "../../../contracts/out/BasejumpLandingNative.sol/BasejumpLandingNative.json";

export type SetDestAssetParams = WalletContext & {
  basejumpLandingAddress: `0x${string}`;
  sourceAsset: `0x${string}`;
  destAsset: `0x${string}`;
};

export type SetDestAssetResult = {
  txHash: string;
  sourceAsset: string;
  destAsset: string;
};

/** Map a source-chain asset to a destination-chain ERC20 payout on BasejumpLandingNative. */
export async function setDestAsset(params: SetDestAssetParams): Promise<SetDestAssetResult> {
  const { publicClient, walletClient, basejumpLandingAddress, sourceAsset, destAsset } = params;
  const { abi } = basejumpLandingNativeJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: basejumpLandingAddress,
    abi,
    functionName: "setDestAsset",
    args: [sourceAsset, destAsset],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash, sourceAsset, destAsset };
}
