import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import basejumpJson from "../../../contracts/out/Basejump.sol/Basejump.json";

export type SetLandingParams = WalletContext & {
  basejumpAddress: `0x${string}`;
  landing: `0x${string}`;
};

export type SetLandingResult = {
  txHash: string;
  landing: string;
};

export async function setLanding(
  params: SetLandingParams,
): Promise<SetLandingResult> {
  const { publicClient, walletClient, basejumpAddress, landing } = params;
  const { abi } = basejumpJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: basejumpAddress,
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
