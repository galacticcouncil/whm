import type { ifs } from "@whm/common";
import type { WalletContext } from "../types";

import oracleEmitterJson from "../../../contracts/out/OracleEmitter.sol/OracleEmitter.json";

export type RegisterFeedParams = WalletContext & {
  proxy: `0x${string}`;
  assetId: `0x${string}`;
  source: `0x${string}`;
  call: `0x${string}`;
};

export type RegisterFeedResult = {
  assetId: string;
  source: string;
  call: string;
  txHash: string;
};

export async function registerFeed(params: RegisterFeedParams): Promise<RegisterFeedResult> {
  const { publicClient, walletClient, proxy, assetId, source, call } = params;
  const { abi } = oracleEmitterJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: proxy,
    abi,
    functionName: "registerFeed",
    args: [assetId, source, call],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  return {
    assetId,
    source,
    call,
    txHash: receipt.transactionHash,
  };
}
