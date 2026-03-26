import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import xcmTransactorJson from "../../../contracts/out/XcmTransactor.sol/XcmTransactor.json";

export type SetAuthorizedParams = WalletContext & {
  transactorAddress: `0x${string}`;
  operator: `0x${string}`;
  enabled: boolean;
};

export type SetAuthorizedResult = {
  txHash: string;
  operator: string;
  enabled: string;
};

export async function setAuthorized(params: SetAuthorizedParams): Promise<SetAuthorizedResult> {
  const { publicClient, walletClient, transactorAddress, operator, enabled } = params;
  const { abi } = xcmTransactorJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: transactorAddress,
    abi,
    functionName: "setAuthorized",
    args: [operator, enabled],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash, operator, enabled: String(enabled) };
}
