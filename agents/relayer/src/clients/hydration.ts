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
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { hydration, HYDRATION_EVM_CHAIN_ID } from "../chains";
import { chainFees } from "../utils/fees";

/** Account plus read and write clients for one chain; writes go to `wallet.chain`. */
export interface ChainClients {
  account: Account;
  publicClient: PublicClient<Transport, Chain>;
  wallet: WalletClient<Transport, Chain, Account>;
}

/** A contract call, independent of the chain it will be sent to. */
export type Call = {
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
};

/**
 * Connect to Hydration's EVM and assert the RPC is the chain we think it is.
 *
 * @param rpcUrl Hydration EVM RPC.
 * @param key Signing key.
 * @returns Account, public client, and wallet client, all built against Hydration.
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

  return { account, publicClient, wallet };
}

/**
 * A keyless, read-only client for Hydration's EVM, for a process whose wallet is on another chain.
 *
 * @param rpcUrl Hydration EVM RPC.
 * @returns A public client built against Hydration.
 * @throws When the RPC reports a different chain id.
 */
export async function hydrationReader(rpcUrl: string): Promise<PublicClient<Transport, Chain>> {
  const publicClient = createPublicClient({ chain: hydration, transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== HYDRATION_EVM_CHAIN_ID) {
    throw new Error(`RPC_HYDRATION returned chain ${chainId}; expected ${HYDRATION_EVM_CHAIN_ID}`);
  }
  return publicClient;
}

/**
 * Submit a call to whichever chain `clients` was built against, under a caller-owned nonce.
 *
 * Simulated first so a revert surfaces as a named error before a nonce is spent — the queue then
 * classifies it rather than burning gas.
 *
 * A gas margin is for a call whose cost depends on the block it lands in: an estimate taken in
 * the block that last wrote a timestamp slot prices that write as unchanged, and the call then
 * runs out of gas one block later. Without one, viem's own estimate is the limit.
 *
 * @param clients Account and clients for the destination chain.
 * @param call The contract, function, and arguments to submit.
 * @param nonce Nonce to submit under.
 * @param opts `gasMarginBps`: gas limit = estimate plus this share of it. `gasFloor`: the least gas
 *   limit, for a call that may do more work at inclusion than when it was estimated.
 * @returns The transaction hash.
 */
export async function submit(
  clients: ChainClients,
  call: Call,
  nonce: number,
  opts: { gasMarginBps?: bigint; gasFloor?: bigint } = {},
): Promise<Hash> {
  const { account, publicClient, wallet } = clients;
  const { to: address, abi, functionName, args } = call;

  await publicClient.simulateContract({ address, abi, functionName, args, account });

  const fees = await chainFees(wallet.chain, publicClient);

  let gas: bigint | undefined;
  if (opts.gasMarginBps || opts.gasFloor) {
    const estimate = await publicClient.estimateContractGas({ address, abi, functionName, args, account });
    gas = estimate + (estimate * (opts.gasMarginBps ?? 0n)) / 10_000n;
    if (opts.gasFloor && gas < opts.gasFloor) gas = opts.gasFloor;
  }

  // Fee fields are always explicit, so viem never falls back to its cached tx-type guess.
  const tx = { address, abi, functionName, args, nonce, account, ...(gas ? { gas } : {}) } as const;
  return fees.kind === "legacy"
    ? wallet.writeContract({ ...tx, gasPrice: fees.gasPrice })
    : wallet.writeContract({
        ...tx,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
}

/**
 * Submit `receiveMessage(vaa)` under a caller-owned nonce.
 *
 * @param clients Account and clients for the destination chain.
 * @param abi ABI carrying `receiveMessage(bytes)`.
 * @param to Contract that consumes the VAA.
 * @param vaaBytes The guardian-signed VAA.
 * @param nonce Nonce to submit under.
 * @param opts As for `submit`.
 * @returns The transaction hash.
 */
export async function receiveMessage(
  clients: ChainClients,
  abi: Abi,
  to: Address,
  vaaBytes: Buffer,
  nonce: number,
  opts: { gasMarginBps?: bigint; gasFloor?: bigint } = {},
): Promise<Hash> {
  const args = [`0x${vaaBytes.toString("hex")}`] as const;
  return submit(clients, { to, abi, functionName: "receiveMessage", args }, nonce, opts);
}
