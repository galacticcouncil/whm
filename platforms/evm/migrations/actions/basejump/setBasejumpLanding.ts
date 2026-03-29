import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import basejumpJson from "../../../contracts/out/Basejump.sol/Basejump.json";

export type SetBasejumpLandingParams = WalletContext & {
  basejumpAddress: `0x${string}`;
  whChainId: number;
  basejumpLanding: `0x${string}`;
};

export type SetBasejumpLandingResult = {
  txHash: string;
  whChainId: string;
  basejumpLanding: string;
};

export async function setBasejumpLanding(
  params: SetBasejumpLandingParams,
): Promise<SetBasejumpLandingResult> {
  const { publicClient, walletClient, basejumpAddress, whChainId, basejumpLanding } = params;
  const { abi } = basejumpJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: basejumpAddress,
    abi,
    functionName: "setBasejumpLanding",
    args: [whChainId, basejumpLanding],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    whChainId: String(whChainId),
    basejumpLanding,
  };
}
