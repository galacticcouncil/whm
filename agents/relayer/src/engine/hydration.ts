import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { hydration, HYDRATION_EVM_CHAIN_ID } from "../chains";

/**
 * Account, clients, and the chain they were built against, returned together so a caller can never
 * assemble the triple wrongly: there is no separate `chain` (or fee-strategy) argument to pass
 * alongside a mismatched set of clients, because the factory that builds the clients is the same
 * factory that names the chain. A destination chain's fee handling lives on `chain` itself (see
 * `../chains`), not here.
 */
export interface ChainClients {
  account: Account;
  publicClient: PublicClient;
  wallet: WalletClient;
  chain: Chain;
}

/**
 * Connect to Hydration's EVM and assert the RPC is the chain we think it is.
 *
 * @param rpcUrl Hydration EVM RPC.
 * @param key Signing key.
 * @returns Account, clients, and the Hydration chain object, paired.
 * @throws When the RPC reports a different chain id.
 */
export async function hydrationClients(rpcUrl: string, key: `0x${string}`): Promise<ChainClients> {
  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: hydration, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, chain: hydration, transport: http(rpcUrl) });

  const chainId = await publicClient.getChainId();
  if (chainId !== HYDRATION_EVM_CHAIN_ID) {
    throw new Error(`RPC_HYDRATION returned chain ${chainId}; expected ${HYDRATION_EVM_CHAIN_ID}`);
  }

  return { account, publicClient, wallet, chain: hydration };
}

/**
 * Submit `receiveMessage(vaa)` to a contract under a caller-owned nonce, on whichever destination
 * chain `clients` was built against.
 *
 * Simulated first so a revert surfaces as a named error before a nonce is spent — the queue then
 * classifies it rather than burning gas.
 *
 * @param clients Account, clients, and chain for the destination (see `ChainClients`).
 * @param abi ABI carrying `receiveMessage(bytes)`.
 * @param to Contract that consumes the VAA.
 * @param vaaBytes The guardian-signed VAA.
 * @param nonce Nonce to submit under.
 * @returns The transaction hash.
 */
export async function receiveMessage(
  clients: ChainClients,
  abi: Abi,
  to: Address,
  vaaBytes: Buffer,
  nonce: number,
): Promise<Hash> {
  const { account, publicClient, wallet, chain } = clients;
  const args = [`0x${vaaBytes.toString("hex")}`] as const;

  await publicClient.simulateContract({
    address: to,
    abi,
    functionName: "receiveMessage",
    args,
    account,
  });

  return wallet.writeContract({
    address: to,
    abi,
    functionName: "receiveMessage",
    args,
    nonce,
    chain,
    account,
  });
}
