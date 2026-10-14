import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import facilitatorJson from "../../../contracts/out-psm/HollarBaseFacilitator.sol/HollarBaseFacilitator.json";
import vaultJson from "../../../contracts/out-psm/HollarBaseVault.sol/HollarBaseVault.json";

/**
 * Bind the counterpart's emitter address. One-shot on both sides: the call freezes itself, so a
 * wrong value here is not correctable by a later setter — only by redeploying that side.
 *
 * Reads before it writes. A resumed run whose bind already landed (receipt timed out, state not
 * saved) must not try again — the second call reverts EmitterAlreadySet and the runner would
 * re-run it on every invocation — and a bind to a different value is the one thing this step
 * must never paper over.
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
  /** Set on a resumed run that found the bind already in place; the original hash was never saved. */
  verifiedAtBlock?: string;
};

export async function setEmitter(params: SetEmitterParams): Promise<SetEmitterResult> {
  const { publicClient, walletClient, contract, functionName, emitter } = params;
  // setBaseEmitter lives on the facilitator, setHydrationEmitter on the vault.
  const isFacilitator = functionName === "setBaseEmitter";
  const { abi } = (isFacilitator ? facilitatorJson : vaultJson) as ifs.ContractArtifact;

  const read = (fn: string, args: unknown[] = []) =>
    publicClient.readContract({ address: contract, abi, functionName: fn, args });

  if ((await read("emitterFrozen")) as boolean) {
    const chainId = (await read(isFacilitator ? "baseChainId" : "hydrationChainId")) as number;
    const bound = (await read("authorizedEmitters", [chainId])) as string;
    if (bound.toLowerCase() !== emitter.toLowerCase()) {
      throw new Error(
        `${functionName}: ${contract} is already bound to ${bound}, not ${emitter} — redeploy that side.`,
      );
    }
    return {
      txHash: "already-bound",
      contract,
      emitter,
      verifiedAtBlock: (await publicClient.getBlockNumber()).toString(),
    };
  }

  const txHash = await walletClient.writeContract({
    address: contract,
    abi,
    functionName,
    args: [emitter],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash, contract, emitter };
}
