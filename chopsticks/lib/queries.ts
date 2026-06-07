import { AccountId, Binary, type SizedHex } from "polkadot-api";

import { hydration } from "@galacticcouncil/descriptors";

import type { Network } from "./network";
import type { EventRecord } from "./events";

const ss58Codec = AccountId();
const toSs58 = (account: string): string =>
  account.startsWith("0x") ? ss58Codec.dec(account) : account;

/**
 * Run a state/event read against an explicit block hash, retrying while papi's WS chainHead lags
 * behind the chopsticks-built block (avoids the `latest`/`head` race entirely).
 */
export async function atBlock<T>(fn: () => Promise<T>, tries = 40): Promise<T> {
  for (let i = 0; i < tries - 1; i++) {
    try {
      return await fn();
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return fn();
}

/** Read a block's events at an explicit hash (typed against the runtime), retrying through WS lag. */
export async function getEventsAt(net: Network, blockHash: string): Promise<EventRecord[]> {
  const api = net.client.getTypedApi(hydration);
  return atBlock(() => api.query.System.Events.getValue({ at: blockHash }));
}

/**
 * Read the deployed EVM bytecode at `address` (pallet_evm::AccountCodes) via the runtime API.
 * Returns `0x` when no contract is deployed.
 */
export async function getAccountCode(
  net: Network,
  address: string,
  atHash?: string,
): Promise<string> {
  const api = net.client.getTypedApi(hydration);
  const code = (await api.apis.EthereumRuntimeRPCApi.account_code_at(
    address as SizedHex<20>,
    atHash ? { at: atHash } : undefined,
  )) as Uint8Array;
  return Binary.toHex(code);
}

/** Read an account's free balance of a Tokens-pallet asset, at an explicit block hash when given. */
export async function getTokenBalance(
  net: Network,
  account: string,
  assetId: number,
  atHash?: string,
): Promise<bigint> {
  const api = net.client.getTypedApi(hydration);
  const v = (await api.query.Tokens.Accounts.getValue(
    account,
    assetId,
    atHash ? { at: atHash } : {},
  )) as { free?: bigint } | undefined;
  return v?.free ?? 0n;
}
