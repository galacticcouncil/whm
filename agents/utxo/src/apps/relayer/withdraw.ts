import { actions, teraToGas, type Account, type JsonRpcProvider } from "near-api-js";

import { checked, events, view } from "../../near/client";
import { decodeSignedDelegate } from "../../near/delegate";

/**
 * A NEP-141 balance.
 *
 * @param provider A NEAR provider.
 * @param token The token contract.
 * @param accountId The holder.
 * @returns The balance, in the token's units.
 */
export async function balanceOf(provider: JsonRpcProvider, token: string, accountId: string): Promise<bigint> {
  return BigInt(await view<string>(provider, token, "ft_balance_of", { account_id: accountId }));
}

/**
 * Create `A` if it does not exist. An implicit account is created by a transfer to it and needs no
 * balance under 770 bytes, so 1 yocto is enough.
 *
 * @param account The relaying account, which pays it.
 * @param accountId `A`.
 * @returns Whether it had to be created.
 */
export async function ensureAccount(account: Account, accountId: string): Promise<boolean> {
  const exists = await account.provider.viewAccount({ accountId }).then(
    () => true,
    () => false,
  );
  if (exists) return false;
  const outcome = await account.signAndSendTransaction({
    receiverId: accountId,
    actions: [actions.transfer(1n)],
    waitUntil: "FINAL",
  });
  checked("create", outcome);
  return true;
}

/**
 * Have the chain's contract sign `A`'s withdrawal of its whole balance to `address` through `coin`,
 * then relay the signed delegate to `A`. A refused sign — UnknownCoin, CoinDoesNotFit, BelowMinimum — or a
 * failed relay throws, and the funds stay in `A`.
 *
 * @param account The relaying account — pays the gas and the inner 1 yocto.
 * @param contract The chain's `UtxoWithdraw`.
 * @param address The destination, `t1…` / `t3…`.
 * @param coin The connector coin to spend, `txid:vout`.
 * @returns The relay transaction hash.
 */
export async function withdraw(
  account: Account,
  contract: string,
  address: string,
  coin: string,
): Promise<string> {
  const signed = checked(
    "withdraw",
    await account.signAndSendTransaction({
      receiverId: contract,
      actions: [actions.functionCall("withdraw", { address, coin }, teraToGas(300), 1n)],
      waitUntil: "FINAL",
    }),
  );
  const event = events(signed, "whm-utxo-withdraw").find((e) => e.event === "signed");
  if (!event) throw new Error(`withdraw ${signed.transaction.hash}: no signed event`);
  const { signed_delegate } = (event.data as { signed_delegate: string }[])[0];
  const delegate = decodeSignedDelegate(Buffer.from(signed_delegate, "base64"));

  const relayed = checked(
    "relay",
    await account.signAndSendTransaction({
      receiverId: delegate.delegateAction.senderId,
      actions: [actions.signedDelegate(delegate)],
      waitUntil: "FINAL",
    }),
  );
  return relayed.transaction.hash;
}
