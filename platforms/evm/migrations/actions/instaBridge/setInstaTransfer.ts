import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import instaBridgeJson from "../../../contracts/out/InstaBridge.sol/InstaBridge.json";

export type SetInstaTransferParams = WalletContext & {
  instaBridgeAddress: `0x${string}`;
  whChainId: number;
  instaTransfer: `0x${string}`;
};

export type SetInstaTransferResult = {
  txHash: string;
  whChainId: string;
  instaTransfer: string;
};

export async function setInstaTransfer(
  params: SetInstaTransferParams,
): Promise<SetInstaTransferResult> {
  const { publicClient, walletClient, instaBridgeAddress, whChainId, instaTransfer } = params;
  const { abi } = instaBridgeJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: instaBridgeAddress,
    abi,
    functionName: "setInstaTransfer",
    args: [whChainId, instaTransfer],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    whChainId: String(whChainId),
    instaTransfer,
  };
}
