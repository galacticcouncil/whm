import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getChain } from "./chains";

export function getWallet(rpcUrl: string, chainId: number, pk: `0x${string}`) {
  const account = privateKeyToAccount(pk);
  const chain = getChain(chainId);

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({
    account: account,
    chain,
    transport,
  });

  return { publicClient, walletClient, account };
}
