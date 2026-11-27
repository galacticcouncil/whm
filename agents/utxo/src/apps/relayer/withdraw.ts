import { actions, teraToGas, type Account, type JsonRpcProvider, type SignedDelegate } from "near-api-js";

import { checked, events, view, type TxOutcome } from "../../near/client";
import { decodeSignedDelegate } from "../../near/delegate";

import { Refused } from "./types";

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
 * `checked`, with a failed receipt as a `Refused`: the chain decided, and the same call decides the
 * same way again.
 *
 * @param label What the transaction was, for the error.
 * @param outcome Its final execution outcome.
 * @returns The same outcome.
 * @throws `Refused` when any receipt failed.
 */
function decided(label: string, outcome: TxOutcome): TxOutcome {
  try {
    return checked(label, outcome);
  } catch (e) {
    throw new Refused((e as Error).message);
  }
}

/**
 * Have the chain's contract sign `A`'s withdrawal of its whole balance to `address` through `coin` —
 * the paid step: the contract's MPC signature.
 *
 * @param account The relaying account — pays the gas and the 1 yocto.
 * @param contract The chain's `UtxoWithdraw`.
 * @param address The destination, `t1…` / `t3…`.
 * @param coin The connector coin to spend, `txid:vout`.
 * @returns The signed delegate, and the signing transaction's hash.
 * @throws `Refused` when the contract will not sign — UnknownCoin, CoinDoesNotFit, BelowMinimum.
 */
export async function signWithdraw(
  account: Account,
  contract: string,
  address: string,
  coin: string,
): Promise<{ delegate: SignedDelegate; tx: string }> {
  const signed = decided(
    "withdraw",
    await account.signAndSendTransaction({
      receiverId: contract,
      actions: [actions.functionCall("withdraw", { address, coin }, teraToGas(300), 1n)],
      waitUntil: "FINAL",
    }),
  );
  const event = events(signed, "whm-utxo-withdraw").find((e) => e.event === "signed");
  if (!event) throw new Refused(`withdraw ${signed.transaction.hash}: no signed event`);
  const { signed_delegate } = (event.data as { signed_delegate: string }[])[0];
  return { delegate: decodeSignedDelegate(Buffer.from(signed_delegate, "base64")), tx: signed.transaction.hash };
}

/**
 * Relay a signed delegate to `A`. Safe to repeat: its nonce lets it land once.
 *
 * @param account The relaying account — pays the gas.
 * @param delegate What `signWithdraw` returned.
 * @returns The relay transaction hash.
 * @throws `Refused` when its receipts failed — the nonce is spent and the funds are back in `A`.
 */
export async function relay(account: Account, delegate: SignedDelegate): Promise<string> {
  const relayed = decided(
    "relay",
    await account.signAndSendTransaction({
      receiverId: delegate.delegateAction.senderId,
      actions: [actions.signedDelegate(delegate)],
      waitUntil: "FINAL",
    }),
  );
  return relayed.transaction.hash;
}
