import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import basejumpProxyJson from "../../../contracts/out/BasejumpProxy.sol/BasejumpProxy.json";

export type SetProxyLandingDestParams = WalletContext & {
  basejumpAddress: `0x${string}`;
  toWhChain: number;
  landingDest: `0x${string}`;
};

export type SetProxyLandingDestResult = {
  txHash: string;
  toWhChain: string;
  landingDest: string;
};

export async function setProxyLandingDest(
  params: SetProxyLandingDestParams,
): Promise<SetProxyLandingDestResult> {
  const { publicClient, walletClient, basejumpAddress, toWhChain, landingDest } = params;
  const { abi } = basejumpProxyJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: basejumpAddress,
    abi,
    functionName: "setLandingDest",
    args: [toWhChain, landingDest],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    toWhChain: String(toWhChain),
    landingDest,
  };
}
