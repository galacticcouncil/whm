import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import basejumpJson from "../../../contracts/out/Basejump.sol/Basejump.json";

export type SetNttManagerParams = WalletContext & {
  basejumpAddress: `0x${string}`;
  asset: `0x${string}`;
  manager: `0x${string}`;
};

export type SetNttManagerResult = {
  txHash: string;
  asset: string;
  manager: string;
};

export async function setNttManager(params: SetNttManagerParams): Promise<SetNttManagerResult> {
  const { publicClient, walletClient, basejumpAddress, asset, manager } = params;
  const { abi } = basejumpJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: basejumpAddress,
    abi,
    functionName: "setNttManager",
    args: [asset, manager],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash, asset, manager };
}
