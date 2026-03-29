import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import basejumpProxyJson from "../../../contracts/out/BasejumpProxy.sol/BasejumpProxy.json";

export type SetXcmTransactorParams = WalletContext & {
  basejumpProxyAddress: `0x${string}`;
  xcmTransactor: `0x${string}`;
};

export type SetXcmTransactorResult = {
  txHash: string;
  xcmTransactor: string;
};

export async function setXcmTransactor(
  params: SetXcmTransactorParams,
): Promise<SetXcmTransactorResult> {
  const { publicClient, walletClient, basejumpProxyAddress, xcmTransactor } = params;
  const { abi } = basejumpProxyJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: basejumpProxyAddress,
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
