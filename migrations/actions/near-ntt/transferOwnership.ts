import { call, checked } from "@whm/common/near";

import type { NearContext } from "../types";

export type TransferOwnershipParams = NearContext & {
  nttAccount: string;
  newOwner: string;
};

export type TransferOwnershipResult = {
  txHash: string;
  newOwner: string;
};

/**
 * Hands the NEAR NTT contract's `owner` to a new account. One step — there is no accept — so the
 * new owner must be an account someone controls. 1 yocto, like every owner method.
 *
 * The new owner is also who upgrades the contract (`upgrade`). Until step 006 deletes the account's
 * keys, the deployer key can redeploy it too; after, only the owner can.
 *
 * @param params Current owner wallet, NTT contract account, new owner
 * @returns The transaction and the new owner
 */
export async function transferOwnership(
  params: TransferOwnershipParams,
): Promise<TransferOwnershipResult> {
  const { account, nttAccount, newOwner } = params;

  const outcome = await call(account, nttAccount, "transfer_ownership", { new_owner: newOwner }, { deposit: 1n });
  checked("transfer_ownership", outcome);

  return { txHash: outcome.transaction.hash, newOwner };
}
