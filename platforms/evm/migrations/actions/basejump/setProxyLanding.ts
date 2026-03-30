import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import basejumpProxyJson from "../../../contracts/out/BasejumpProxy.sol/BasejumpProxy.json";

export type SetProxyLandingParams = WalletContext & {
  basejumpAddress: `0x${string}`;
  fromWhChain: number;
  landing: `0x${string}`;
};

export type SetProxyLandingResult = {
  txHash: string;
  fromWhChain: string;
  landing: string;
};

export async function setProxyLanding(
  params: SetProxyLandingParams,
): Promise<SetProxyLandingResult> {
  const { publicClient, walletClient, basejumpAddress, fromWhChain, landing } = params;
  const { abi } = basejumpProxyJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: basejumpAddress,
    abi,
    functionName: "setLanding",
    args: [fromWhChain, landing],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    fromWhChain: String(fromWhChain),
    landing,
  };
}
