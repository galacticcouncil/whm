import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import oracleDispatcherJson from "../../../out/OracleDispatcher.sol/OracleDispatcher.json";

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
  const { abi } = oracleDispatcherJson as ifs.ContractArtifact;

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
