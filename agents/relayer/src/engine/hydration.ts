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

/**
 * STATUS (issue #45): `submit` below takes its destination chain from `ChainClients` rather than
 * hardcoding Hydration, so the same function can in principle submit to Base or another EVM
 * chain. Only Hydration is wired up, built, and exercised in this repo today: `hydrationClients`
 * is the only factory, `ntt`/`oracle` are its only callers, and `scripts/verify-hydration-fees.ts`
 * only tests the Hydration path. A Base client/chain and its own exercise is issue #46; nothing in
 * this file builds or runs against Base.
 */

/**
 * Account, public client, and wallet client, returned together by one factory and typed against
 * one another: `wallet` is a `WalletClient<Transport, Chain, Account>`, so its `chain` is not
 * optional and not a separate value a caller could pass instead. The destination chain travels on
 * the wallet client itself, the same object every write already goes through, rather than as a
 * fourth field beside it.
 *
 * A mismatched pairing — Hydration's clients built against Base's chain, say — is prevented by
 * construction, not by convention: `hydrationClients` below is the only thing that builds a
 * `ChainClients`, and it builds `publicClient` and `wallet` from the same `hydration` chain object
 * in the same call, so there is no seam at which a caller could hand it one chain's clients and a
 * different chain's identity. A second factory (Base's, when #46 adds one) has the same shape:
 * both its clients built from its own chain object, in its own function, once.
 */
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
 * Submit a call to whichever chain `clients` was built against, under a caller-owned nonce.
 *
 * Simulated first so a revert surfaces as a named error before a nonce is spent — the queue then
 * classifies it rather than burning gas.
 *
 * @param clients Account and clients for the destination (see `ChainClients`). The chain itself
 *   comes from `clients.wallet.chain`; there is no separate chain argument to pass or mismatch.
 * @param call The contract, function, and arguments to submit.
 * @param nonce Nonce to submit under.
 * @returns The transaction hash.
 */
export async function submit(clients: ChainClients, call: Call, nonce: number): Promise<Hash> {
  const { account, publicClient, wallet } = clients;
  const { to: address, abi, functionName, args } = call;

  await publicClient.simulateContract({ address, abi, functionName, args, account });

  const fees = await chainFees(wallet.chain, publicClient);

  // Every write sets its fee fields explicitly. viem's `getTransactionType` resolves the
  // transaction type from whichever fields are present, so it is decided fresh on every call and
  // never falls back to reading its per-client `eip1559NetworkCache` — the cache a long-lived
  // client would otherwise carry from its first submission into every later one.
  const tx = { address, abi, functionName, args, nonce, account } as const;
  return fees.kind === "legacy"
    ? wallet.writeContract({ ...tx, gasPrice: fees.gasPrice })
    : wallet.writeContract({
        ...tx,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
}

/**
 * Submit `receiveMessage(vaa)` to a contract under a caller-owned nonce, on whichever destination
 * chain `clients` was built against. A thin wrapper around `submit` for this repo's one call
 * shape.
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
  const args = [`0x${vaaBytes.toString("hex")}`] as const;
  return submit(clients, { to, abi, functionName: "receiveMessage", args }, nonce);
}
