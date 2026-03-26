import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import instaBridgeJson from "../../../contracts/out/InstaBridge.sol/InstaBridge.json";

export type SetFeeBpsParams = WalletContext & {
  instaBridgeAddress: `0x${string}`;
  feeBps: bigint;
};

export type SetFeeBpsResult = {
  txHash: string;
  feeBps: string;
};

export async function setFeeBps(params: SetFeeBpsParams): Promise<SetFeeBpsResult> {
  const { publicClient, walletClient, instaBridgeAddress, feeBps } = params;
  const { abi } = instaBridgeJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: instaBridgeAddress,
    abi,
    functionName: "setFeeBps",
    args: [feeBps],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    feeBps: String(feeBps),
  };
}
