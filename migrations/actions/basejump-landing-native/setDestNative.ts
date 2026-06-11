import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import basejumpLandingNativeJson from "../../../contracts/out/BasejumpLandingNative.sol/BasejumpLandingNative.json";

export type SetDestNativeParams = WalletContext & {
  basejumpLandingAddress: `0x${string}`;
  sourceAsset: `0x${string}`;
};

export type SetDestNativeResult = {
  txHash: string;
  sourceAsset: string;
};

/** Map a source-chain asset to native-ETH payout on BasejumpLandingNative (destAssetFor → NATIVE). */
export async function setDestNative(params: SetDestNativeParams): Promise<SetDestNativeResult> {
  const { publicClient, walletClient, basejumpLandingAddress, sourceAsset } = params;
  const { abi } = basejumpLandingNativeJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: basejumpLandingAddress,
    abi,
    functionName: "setDestNative",
    args: [sourceAsset],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash, sourceAsset };
}
