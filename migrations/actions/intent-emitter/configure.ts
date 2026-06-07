import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import intentEmitterJson from "../../../contracts/out/IntentEmitter.sol/IntentEmitter.json";

export type ConfigureParams = WalletContext & {
  emitter: `0x${string}`;
  basejumpProxy: `0x${string}`;
  intentRouter: `0x${string}`; // bytes32
};

export type ConfigureResult = {
  setProxyTx: string;
  setRouterTx: string;
  basejumpProxy: string;
  intentRouter: string;
};

export async function configure(params: ConfigureParams): Promise<ConfigureResult> {
  const { publicClient, walletClient, emitter, basejumpProxy, intentRouter } = params;
  const { abi } = intentEmitterJson as ifs.ContractArtifact;

  const setProxyTx = await walletClient.writeContract({
    address: emitter,
    abi,
    functionName: "setProxy",
    args: [basejumpProxy],
  });
  await publicClient.waitForTransactionReceipt({ hash: setProxyTx });

  const setRouterTx = await walletClient.writeContract({
    address: emitter,
    abi,
    functionName: "setRouter",
    args: [intentRouter],
  });
  await publicClient.waitForTransactionReceipt({ hash: setRouterTx });

  return { setProxyTx, setRouterTx, basejumpProxy, intentRouter };
}
