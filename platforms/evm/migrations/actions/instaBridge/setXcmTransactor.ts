import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import instaBridgeProxyJson from "../../../contracts/out/InstaBridgeProxy.sol/InstaBridgeProxy.json";

export type SetXcmTransactorParams = WalletContext & {
  instaBridgeProxyAddress: `0x${string}`;
  xcmTransactor: `0x${string}`;
};

export type SetXcmTransactorResult = {
  txHash: string;
  xcmTransactor: string;
};

export async function setXcmTransactor(
  params: SetXcmTransactorParams,
): Promise<SetXcmTransactorResult> {
  const { publicClient, walletClient, instaBridgeProxyAddress, xcmTransactor } = params;
  const { abi } = instaBridgeProxyJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: instaBridgeProxyAddress,
    abi,
    functionName: "setXcmTransactor",
    args: [xcmTransactor],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    xcmTransactor,
  };
}
