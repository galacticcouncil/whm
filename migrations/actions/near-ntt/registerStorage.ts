import { call, checked, view } from "@whm/common/near";

import type { NearContext } from "../types";

export type RegisterStorageParams = NearContext & {
  token: string;
  nttAccount: string;
};

export type RegisterStorageResult = {
  txHash: string;
  deposit: string;
};

type StorageBalanceBounds = { min: string; max: string | null };

/**
 * Registers the NTT contract's storage on its token (NEP-145). Without it the contract cannot hold
 * custody: the first `ft_transfer_call` into it would fail on the token side.
 *
 * @param params Deployer wallet (pays), token, NTT contract account
 * @returns The transaction and the deposit paid, `storage_balance_bounds().min`
 */
export async function registerStorage(params: RegisterStorageParams): Promise<RegisterStorageResult> {
  const { account, provider, token, nttAccount } = params;

  const bounds = await view<StorageBalanceBounds>(provider, token, "storage_balance_bounds");
  const outcome = await call(
    account,
    token,
    "storage_deposit",
    { account_id: nttAccount, registration_only: true },
    { deposit: BigInt(bounds.min) },
  );
  checked("storage_deposit", outcome);

  return { txHash: outcome.transaction.hash, deposit: bounds.min };
}
