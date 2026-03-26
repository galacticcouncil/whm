import type { ifs } from "../../../lib";
import type { WalletContext } from "../../types";

import xcmTransactorJson from "../../../contracts/out/XcmTransactor.sol/XcmTransactor.json";

export type SetDefaultsParams = WalletContext & {
  transactorAddress: `0x${string}`;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  transactWeight: bigint;
  transactProofSize: bigint;
  feeAmount: bigint;
};

export type SetDefaultsResult = {
  txHash: string;
  transactorAddress: string;
};

export async function setDefaults(params: SetDefaultsParams): Promise<SetDefaultsResult> {
  const {
    publicClient,
    walletClient,
    transactorAddress,
    gasLimit,
    maxFeePerGas,
    transactWeight,
    transactProofSize,
    feeAmount,
  } = params;
  const { abi } = xcmTransactorJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: transactorAddress,
    abi,
    functionName: "setXcmDefaults",
    args: [gasLimit, maxFeePerGas, transactWeight, transactProofSize, feeAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash, transactorAddress };
}
