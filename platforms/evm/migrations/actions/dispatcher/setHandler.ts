import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import messageDispatcherJson from "../../../contracts/out/MessageDispatcher.sol/MessageDispatcher.json";

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
  const { abi } = messageDispatcherJson as ifs.ContractArtifact;

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
