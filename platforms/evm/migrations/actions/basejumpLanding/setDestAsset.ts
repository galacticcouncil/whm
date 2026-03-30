import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import basejumpLandingJson from "../../../contracts/out/BasejumpLanding.sol/BasejumpLanding.json";

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

export async function setDestAsset(
  params: SetDestAssetParams,
): Promise<SetDestAssetResult> {
  const { publicClient, walletClient, basejumpLandingAddress, sourceAsset, destAsset } = params;
  const { abi } = basejumpLandingJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: basejumpLandingAddress,
    abi,
    functionName: "setDestAsset",
    args: [sourceAsset, destAsset],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    sourceAsset,
    destAsset,
  };
}
