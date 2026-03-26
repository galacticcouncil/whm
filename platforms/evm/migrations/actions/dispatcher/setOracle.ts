import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import messageDispatcherJson from "../../../contracts/out/MessageDispatcher.sol/MessageDispatcher.json";

export type SetOracleParams = WalletContext & {
  dispatcherAddress: `0x${string}`;
  assetId: string;
  oracle: `0x${string}`;
};

export type SetOracleResult = {
  txHash: string;
  assetId: string;
  oracle: string;
};

export async function setOracle(
  params: SetOracleParams,
): Promise<SetOracleResult> {
  const { publicClient, walletClient, dispatcherAddress, assetId, oracle } =
    params;
  const { abi } = messageDispatcherJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: dispatcherAddress,
    abi,
    functionName: "setOracle",
    args: [assetId, oracle],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    assetId,
    oracle,
  };
}
