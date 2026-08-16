import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import receiverJson from "../../../contracts/out/BasejumpMessageReceiver.sol/BasejumpMessageReceiver.json";

export type SetLandingParams = WalletContext & {
  receiverAddress: `0x${string}`;
  landing: `0x${string}`;
};

export type SetLandingResult = {
  txHash: string;
  landing: string;
};

export async function setLanding(params: SetLandingParams): Promise<SetLandingResult> {
  const { publicClient, walletClient, receiverAddress, landing } = params;
  const { abi } = receiverJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: receiverAddress,
    abi,
    functionName: "setLanding",
    args: [landing],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    landing,
  };
}
