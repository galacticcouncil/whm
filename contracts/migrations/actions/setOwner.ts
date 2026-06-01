import type { WalletContext } from "../types";

const SET_OWNER_ABI = [
  {
    type: "function",
    name: "setOwner",
    inputs: [{ name: "newOwner", type: "address", internalType: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export type SetOwnerParams = WalletContext & {
  contract: `0x${string}`;
  newOwner: `0x${string}`;
};

export type SetOwnerResult = {
  txHash: string;
  contract: string;
  newOwner: string;
};

export async function setOwner(params: SetOwnerParams): Promise<SetOwnerResult> {
  const { publicClient, walletClient, contract, newOwner } = params;

  const txHash = await walletClient.writeContract({
    address: contract,
    abi: SET_OWNER_ABI,
    functionName: "setOwner",
    args: [newOwner],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  return { txHash, contract, newOwner };
}
