import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import instaTransferJson from "../../../contracts/out/InstaTransfer.sol/InstaTransfer.json";

export type SetAuthorizedBridgeParams = WalletContext & {
  instaTransferAddress: `0x${string}`;
  bridgeAddress: `0x${string}`;
  enabled: boolean;
};

export type SetAuthorizedBridgeResult = {
  txHash: string;
  bridgeAddress: string;
  enabled: string;
};

export async function setAuthorizedBridge(
  params: SetAuthorizedBridgeParams,
): Promise<SetAuthorizedBridgeResult> {
  const { publicClient, walletClient, instaTransferAddress, bridgeAddress, enabled } = params;
  const { abi } = instaTransferJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: instaTransferAddress,
    abi,
    functionName: "setAuthorizedBridge",
    args: [bridgeAddress, enabled],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    bridgeAddress,
    enabled: String(enabled),
  };
}
