import type { ifs } from "@whm/common/evm";
import type { WalletContext } from "../types";

import vaultJson from "../../../contracts/out-psm/HollarBaseVault.sol/HollarBaseVault.json";

export type TxResult = { txHash: string; contract: string };

export type SetFeesParams = WalletContext & {
  contract: `0x${string}`;
  redeemFeeBps: bigint;
  surplusFloorBps: bigint;
};

export async function setFees(params: SetFeesParams): Promise<TxResult> {
  const { publicClient, walletClient, contract } = params;
  const { abi } = vaultJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: contract,
    abi,
    functionName: "setFees",
    args: [params.redeemFeeBps, params.surplusFloorBps],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash, contract };
}

export type SetDepositLimitParams = WalletContext & {
  contract: `0x${string}`;
  capacity: bigint;
  window: bigint;
};

export async function setDepositLimit(params: SetDepositLimitParams): Promise<TxResult> {
  const { publicClient, walletClient, contract, capacity, window } = params;
  const { abi } = vaultJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: contract,
    abi,
    functionName: "setDepositLimit",
    args: [capacity, window],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash, contract };
}
