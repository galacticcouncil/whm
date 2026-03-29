import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import basejumpLandingJson from "../../../contracts/out/BasejumpLanding.sol/BasejumpLanding.json";

export type SetAuthorizedBridgeParams = WalletContext & {
  basejumpLandingAddress: `0x${string}`;
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
  const { publicClient, walletClient, basejumpLandingAddress, bridgeAddress, enabled } = params;
  const { abi } = basejumpLandingJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: basejumpLandingAddress,
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
