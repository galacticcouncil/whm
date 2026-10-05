import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import facilitatorJson from "../../../contracts/out-psm/HollarBaseFacilitator.sol/HollarBaseFacilitator.json";

export type SetLimitsParams = WalletContext & {
  contract: `0x${string}`;
  inboundCapacity: bigint;
  outboundCapacity: bigint;
  window: bigint;
};

export type TxResult = { txHash: string; contract: string };

/** Both directions share one window. A zero capacity is closed, not unlimited. */
export async function setLimits(params: SetLimitsParams): Promise<TxResult> {
  const { publicClient, walletClient, contract } = params;
  const { abi } = facilitatorJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: contract,
    abi,
    functionName: "setLimits",
    args: [params.inboundCapacity, params.outboundCapacity, params.window],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash, contract };
}
