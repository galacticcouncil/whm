import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import instaBridgeJson from "../../../contracts/out/InstaBridge.sol/InstaBridge.json";

export type SetAuthorizedEmitterParams = WalletContext & {
  instaBridgeAddress: `0x${string}`;
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
  const { publicClient, walletClient, instaBridgeAddress, emitter, emitterChain } = params;
  const { abi } = instaBridgeJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: instaBridgeAddress,
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
