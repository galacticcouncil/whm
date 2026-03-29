import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import basejumpJson from "../../../contracts/out/Basejump.sol/Basejump.json";

export type SetAuthorizedEmitterParams = WalletContext & {
  basejumpAddress: `0x${string}`;
  emitter: `0x${string}`;
  emitterChain: number;
};

export type SetAuthorizedEmitterResult = {
  txHash: string;
  emitterChain: string;
  emitter: string;
};

export async function setAuthorizedEmitter(
  params: SetAuthorizedEmitterParams,
): Promise<SetAuthorizedEmitterResult> {
  const { publicClient, walletClient, basejumpAddress, emitter, emitterChain } = params;
  const { abi } = basejumpJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: basejumpAddress,
    abi,
    functionName: "setAuthorizedEmitter",
    args: [emitterChain, emitter],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    txHash,
    emitterChain: String(emitterChain),
    emitter,
  };
}
