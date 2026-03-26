import { isAddress, pad } from "viem";

import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import messageReceiverJson from "../../../contracts/out/MessageReceiver.sol/MessageReceiver.json";

export type SetAuthorizedEmitterParams = WalletContext & {
  receiverAddress: `0x${string}`;
  emitter: `0x${string}`;
  sourceChain: string;
};

export type SetAuthorizedEmitterResult = {
  txHash: string;
  emitterBytes32: string;
  sourceChain: string;
};

export async function setAuthorizedEmitter(
  params: SetAuthorizedEmitterParams,
): Promise<SetAuthorizedEmitterResult> {
  const { publicClient, walletClient, receiverAddress, emitter, sourceChain } = params;
  const { abi } = messageReceiverJson as ifs.ContractArtifact;

  // Normalize to bytes32 (pad if it's a 20-byte address)
  const isBytes32 = emitter.length === 66;
  const emitterBytes32 = isBytes32 ? emitter : pad(emitter, { size: 32 });

  const txHash = await walletClient.writeContract({
    address: receiverAddress,
    abi,
    functionName: "setAuthorizedEmitter",
    args: [sourceChain, emitterBytes32],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash, emitterBytes32, sourceChain };
}
