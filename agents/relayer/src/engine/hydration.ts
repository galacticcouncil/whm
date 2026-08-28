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
 * STATUS (issue #45): `receiveMessage` below takes its destination chain from `ChainClients`
 * rather than hardcoding Hydration, so the same function can in principle submit to Base or
 * another EVM chain. Only Hydration is wired up, built, and exercised in this repo today:
 * `hydrationClients` is the only factory, `ntt`/`oracle` are its only callers, and
 * `scripts/verify-hydration-fees.ts` only tests the Hydration path. A Base client/chain and its own
 * exercise is issue #46; nothing in this file builds or runs against Base.
 */

/**
 * Account, clients, and the chain they were built against, returned together by one factory. No
 * argument here invites mismatching them: there is no separate `chain` (or fee-strategy) parameter
 * for a caller to pass alongside a different set of clients, because `hydrationClients` below hands
 * back all three at once. A destination chain's fee handling lives on `chain` itself (see
 * `../chains`), not here.
 *
 * This is a convention, not a type-level guarantee: `ChainClients` is a plain exported interface,
 * so a hand-built value pairing Hydration's clients with a different chain still type-checks and
 * still runs, since TypeScript's structural typing has no way to see that `publicClient` was
 * created against `hydration` specifically. Each per-chain factory (Base's, when #46 adds one) has
 * to uphold the pairing itself; nothing here enforces it once, centrally, for all of them.
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
