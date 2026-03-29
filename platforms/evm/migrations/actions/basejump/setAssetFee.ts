import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import basejumpJson from "../../../contracts/out/Basejump.sol/Basejump.json";

export type SetAssetFeeParams = WalletContext & {
  basejumpAddress: `0x${string}`;
  fee: bigint;
};

export type SetAssetFeeResult = {
  txHash: string;
  fee: string;
};

export async function setAssetFee(params: SetAssetFeeParams): Promise<SetAssetFeeResult> {
  const { publicClient, walletClient, basejumpAddress, fee } = params;
  const { abi } = basejumpJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: basejumpAddress,
    abi,
    functionName: "setAssetFee",
    args: [fee],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    fee: String(fee),
  };
}
