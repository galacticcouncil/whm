import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { base, BASE_EVM_CHAIN_ID } from "../chains";

import type { ChainClients } from "./hydration";

/**
 * Mirrors `hydrationClients` in `./hydration` — same argument shape, same `ChainClients` return
 * shape, same chain-id assertion mechanism — so `RPC_BASE` fails the same loud way rather than
 * quietly relaying against the wrong network. `submit`/`receiveMessage` (in `./hydration`) already
 * take their destination chain from `ChainClients` rather than hardcoding Hydration, so they work
 * unchanged against whatever this factory returns. Fees for a Base submission come from
 * `chainFees`'s generic branch (`../utils/fees`), called fresh on every `submit` — the same call
 * Hydration goes through, not a chain-object hook and not anything cached on the client. See
 * `scripts/verify-base-clients.ts` for the constructed evidence.
 */

/**
 * Connect to Base's EVM and assert the RPC is the chain we think it is.
 *
 * @param rpcUrl Base EVM RPC.
 * @param key Base's own signing key (see `privateKeyBase` in `../config`). Kept apart from `PRIVKEY`
 *   so the Base wallet's funds and key are not those of a Hydration wallet.
 * @returns Account, public client, and wallet client, all built against Base.
 * @throws When the RPC reports a different chain id.
 */
export async function baseClients(rpcUrl: string, key: `0x${string}`): Promise<ChainClients> {
  const account = privateKeyToAccount(key);
  // Base's op-stack `formatters` give `createPublicClient`/`createWalletClient` a more specific
  // return type (an extra "deposit" transaction variant) than the bare `PublicClient<Transport,
  // Chain>`/`WalletClient<Transport, Chain, Account>` types `ChainClients` is declared with — a
  // real, chain-object-driven type, not a loosely-typed client. Widened here, at construction, to
  // the shape the rest of the codebase (`submit`, `receiveMessage`, the queue) already reads
  // Hydration's clients as; nothing about the runtime client changes.
  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  }) as unknown as PublicClient<Transport, Chain>;
  const wallet = createWalletClient({
    account,
    chain: base,
    transport: http(rpcUrl),
  }) as unknown as WalletClient<Transport, Chain, Account>;

  const chainId = await publicClient.getChainId();
  if (chainId !== BASE_EVM_CHAIN_ID) {
    throw new Error(`RPC_BASE returned chain ${chainId}; expected ${BASE_EVM_CHAIN_ID}`);
  }

  return { account, publicClient, wallet };
}
