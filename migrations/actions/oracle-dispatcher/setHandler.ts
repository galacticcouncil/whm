import type { ifs } from "@whm/common";
import type { WalletContext } from "../../evm";

import oracleDispatcherJson from "../../../contracts/out/OracleDispatcher.sol/OracleDispatcher.json";

export type SetHandlerParams = WalletContext & {
  dispatcherAddress: `0x${string}`;
  actionId: number;
  handler: `0x${string}`;
};

export type SetHandlerResult = {
  txHash: string;
  actionId: string;
  handler: string;
};

export async function setHandler(
  params: SetHandlerParams,
): Promise<SetHandlerResult> {
  const { publicClient, walletClient, dispatcherAddress, actionId, handler } =
    params;
  const { abi } = oracleDispatcherJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: dispatcherAddress,
    abi,
    functionName: "setHandler",
    args: [actionId, handler],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    actionId: String(actionId),
    handler,
  };
}
