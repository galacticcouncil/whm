import { call, checked, view } from "@whm/common/near";

import type { NearContext } from "../types";

export type AcceptOwnershipParams = NearContext & {
  nttAccount: string;
  newOwner: string;
};

export type AcceptOwnershipResult = {
  /** Empty when the new owner accepted outside this migration. */
  txHash: string;
  owner: string;
};

/**
 * Completes the handover `transferOwnership` proposed. If the new owner is this wallet's account,
 * it accepts here; otherwise it only checks that the new owner has — and throws until it has, so
 * the migration stops here and a re-run picks it up once the custodian calls `accept_ownership`.
 *
 * @param params Deployer wallet, NTT contract account, the proposed owner
 * @returns The accepting transaction (if this wallet sent it) and the contract's owner
 */
export async function acceptOwnership(params: AcceptOwnershipParams): Promise<AcceptOwnershipResult> {
  const { account, provider, nttAccount, newOwner } = params;

  // Owner already, and not still proposed — a custodian that is the deployer is both until it accepts.
  const pending = await view<string | null>(provider, nttAccount, "pending_owner");
  if ((await view<string>(provider, nttAccount, "owner")) === newOwner && pending !== newOwner) {
    return { txHash: "", owner: newOwner };
  }

  if (newOwner !== account.accountId) {
    throw new Error(
      `Waiting for ${newOwner} to call accept_ownership on ${nttAccount} (1 yocto; pending_owner: ${pending}) — re-run once it has`,
    );
  }

  const outcome = await call(account, nttAccount, "accept_ownership", {}, { deposit: 1n });
  checked("accept_ownership", outcome);

  const owner = await view<string>(provider, nttAccount, "owner");
  if (owner !== newOwner) throw new Error(`accept_ownership: owner is ${owner}, expected ${newOwner}`);
  return { txHash: outcome.transaction.hash, owner };
}
