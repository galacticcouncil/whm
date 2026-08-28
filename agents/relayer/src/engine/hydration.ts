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
import type { FeeStrategy } from "../utils/fees";

/** Account plus read/write clients for a submission. Not chain-specific: only the shape needed to
 *  simulate and send a contract call. */
export interface Clients {
  account: Account;
  publicClient: PublicClient;
  wallet: WalletClient;
}

/**
 * Connect to Hydration's EVM and assert the RPC is the chain we think it is.
 *
 * @param rpcUrl Hydration EVM RPC.
 * @param key Signing key.
 * @returns Account plus read and write clients.
 * @throws When the RPC reports a different chain id.
 */
export async function hydrationClients(rpcUrl: string, key: `0x${string}`): Promise<Clients> {
  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: hydration, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account, chain: hydration, transport: http(rpcUrl) });

  const chainId = await publicClient.getChainId();
  if (chainId !== HYDRATION_EVM_CHAIN_ID) {
    throw new Error(`RPC_HYDRATION returned chain ${chainId}; expected ${HYDRATION_EVM_CHAIN_ID}`);
  }

  return { account, publicClient, wallet };
}

/**
 * Submit `receiveMessage(vaa)` to a contract under a caller-owned nonce, on whichever destination
 * chain the caller passes in.
 *
 * Simulated first so a revert surfaces as a named error before a nonce is spent — the queue then
 * classifies it rather than burning gas.
 *
 * @param clients Account and clients for the destination chain.
 * @param chain The destination chain, e.g. `hydration` from `../chains` or viem's `base`.
 * @param feeStrategy How to price the submission on that chain. Pass `hydrationFees` for
 *   Hydration (no priority fee, and some compatible RPCs omit `eth_maxPriorityFeePerGas`) or
 *   `defaultFees` (`../utils/fees`) for an ordinary EVM chain, which lets `writeContract` estimate
 *   fees itself.
 * @param abi ABI carrying `receiveMessage(bytes)`.
 * @param to Contract that consumes the VAA.
 * @param vaaBytes The guardian-signed VAA.
 * @param nonce Nonce to submit under.
 * @returns The transaction hash.
 */
export async function receiveMessage(
  clients: Clients,
  chain: Chain,
  feeStrategy: FeeStrategy,
  abi: Abi,
  to: Address,
  vaaBytes: Buffer,
  nonce: number,
): Promise<Hash> {
  const { account, publicClient, wallet } = clients;
  const args = [`0x${vaaBytes.toString("hex")}`] as const;

  await publicClient.simulateContract({
    address: to,
    abi,
    functionName: "receiveMessage",
    args,
    account,
  });

  const fees = await feeStrategy(publicClient);
  const call = {
    address: to,
    abi,
    functionName: "receiveMessage",
    args,
    nonce,
    chain,
    account,
  } as const;

  if (!fees) {
    return wallet.writeContract(call);
  }

  return fees.kind === "legacy"
    ? wallet.writeContract({ ...call, gasPrice: fees.gasPrice })
    : wallet.writeContract({
        ...call,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
}
