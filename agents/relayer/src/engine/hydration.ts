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
 * exercises the generic branch only against offline chain objects over a mocked transport. A Base
 * client/chain and its own exercise is issue #46; nothing in this file builds or runs against Base.
 */

/**
 * Account, public client, and wallet client, returned together by one factory and typed against
 * one another: `wallet` is a `WalletClient<Transport, Chain, Account>`, so its `chain` is not
 * optional and not a separate value a caller could pass instead. The destination chain travels on
 * the wallet client itself, the same object every write already goes through, rather than as a
 * fourth field beside it.
 *
 * The loose `chain` argument the earlier draft carried is gone; there is no longer a fourth value
 * a caller could pass alongside the wrong pair. `ChainClients` itself is still a plain exported
 * structural interface, though, with `publicClient` and `wallet` typed against independent `Chain`
 * generics — nothing in the type stops a hand-built value from pairing a `publicClient` built
 * against one chain with a `wallet` built against another, and such a value still typechecks and
 * still signs, silently, for whichever chain `wallet.chain` names (`scripts/verify-hydration-fees.ts`'s
 * `genericClients()` builds a `ChainClients` by hand to exercise the generic branch; it happens to
 * build both clients from one chain object, but nothing in the type required it to). The actual
 * guard is procedural, not type-level: `hydrationClients` below is the only function in this repo
 * that produces a `ChainClients`, and it builds `publicClient` and `wallet` from the same
 * `hydration` chain object in the same call. A second factory (Base's, when #46 adds one) has to
 * keep that same shape — both its clients built from its own chain object, in its own function —
 * on its own; nothing here enforces it centrally across factories.
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

  // Every write sets its fee fields explicitly, and `chainFees` above only ever returns a
  // `FeeOverrides` whose fields are actually `bigint` — it validates that at runtime, not just by
  // TS declaration, since viem's own fee estimator can return an unvalidated shape (see the doc
  // comment on `chainFees`). So `getTransactionType` always resolves the transaction type from
  // real fields present on this call, decided fresh every time, and never falls back to reading
  // its per-client `eip1559NetworkCache` — the cache a long-lived client would otherwise carry
  // from its first submission into every later one.
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
 * @param clients Account and clients for the destination (see `ChainClients`).
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
