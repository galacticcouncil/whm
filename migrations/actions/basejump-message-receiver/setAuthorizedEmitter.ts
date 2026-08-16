import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import receiverJson from "../../../contracts/out/BasejumpMessageReceiver.sol/BasejumpMessageReceiver.json";

export type SetAuthorizedEmitterParams = WalletContext & {
  receiverAddress: `0x${string}`;
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
  const { publicClient, walletClient, receiverAddress, emitter, emitterChain } = params;
  const { abi } = receiverJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: receiverAddress,
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
