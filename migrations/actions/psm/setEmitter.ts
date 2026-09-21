import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import facilitatorJson from "../../../contracts/out-psm/HollarBaseFacilitator.sol/HollarBaseFacilitator.json";
import vaultJson from "../../../contracts/out-psm/HollarBaseVault.sol/HollarBaseVault.json";

/**
 * Bind the counterpart's emitter address. One-shot on both sides: the call freezes itself, so a
 * wrong value here is not correctable by a later setter — only by redeploying that side.
 */
export type SetEmitterParams = WalletContext & {
  contract: `0x${string}`;
  functionName: "setBaseEmitter" | "setHydrationEmitter";
  emitter: `0x${string}`;
};

export type SetEmitterResult = {
  txHash: string;
  contract: string;
  emitter: string;
};

export async function setEmitter(params: SetEmitterParams): Promise<SetEmitterResult> {
  const { publicClient, walletClient, contract, functionName, emitter } = params;
  // setBaseEmitter lives on the facilitator, setHydrationEmitter on the vault.
  const { abi } = (functionName === "setBaseEmitter"
    ? facilitatorJson
    : vaultJson) as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: contract,
    abi,
    functionName,
    args: [emitter],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash, contract, emitter };
}
