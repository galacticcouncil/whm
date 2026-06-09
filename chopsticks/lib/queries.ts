import { Binary, type SizedHex } from "polkadot-api";

import { hydration } from "@galacticcouncil/descriptors";

import type { Network } from "./network";
import type { EventRecord } from "./events";

/** Read a block's events at an explicit hash (typed against the runtime), retrying through WS lag. */
export async function getEventsAt(net: Network, blockHash: string): Promise<EventRecord[]> {
  const api = net.client.getTypedApi(hydration);
  return api.query.System.Events.getValue({ at: blockHash });
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
