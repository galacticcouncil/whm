import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import oracleReceiverJson from "../../../contracts/out/OracleReceiver.sol/OracleReceiver.json";

export type SetOracleParams = WalletContext & {
  receiverAddress: `0x${string}`;
  assetId: string;
  oracle: `0x${string}`;
};

export type SetOracleResult = {
  txHash: string;
  assetId: string;
  oracle: string;
};

export async function setOracle(params: SetOracleParams): Promise<SetOracleResult> {
  const { publicClient, walletClient, receiverAddress, assetId, oracle } = params;
  const { abi } = oracleReceiverJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: receiverAddress,
    abi,
    functionName: "setOracle",
    args: [assetId, oracle],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash, assetId, oracle };
}
