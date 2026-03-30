import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import basejumpJson from "../../../contracts/out/Basejump.sol/Basejump.json";

export type SetLandingDestParams = WalletContext & {
  basejumpAddress: `0x${string}`;
  landingDest: `0x${string}`;
};

export type SetLandingDestResult = {
  txHash: string;
  landingDest: string;
};

export async function setLandingDest(
  params: SetLandingDestParams,
): Promise<SetLandingDestResult> {
  const { publicClient, walletClient, basejumpAddress, landingDest } = params;
  const { abi } = basejumpJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: basejumpAddress,
    abi,
    functionName: "setLandingDest",
    args: [landingDest],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    landingDest,
  };
}
