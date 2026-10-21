import {
  Account,
  actions,
  JsonRpcProvider,
  KeyPairSigner,
  nearToYocto,
  teraToGas,
  type KeyPairString,
} from "near-api-js";

import { req } from "../config";

/**
 * NEAR as a destination. The first app that signs on NEAR rather than an EVM chain, so it has its own
 * key pair (`NEAR_ACCOUNT_ID`, `NEAR_PRIVKEY`) — an `ed25519:` secret is not an EVM key, and the
 * wallet holds NEAR, not ETH.
 */

/** Panics meaning the transfer is already redeemed — someone else completed it first. */
const DONE_PANICS = ["AlreadyExecuted"];

/**
 * The signing account and the provider it sends through.
 *
 * @param rpcUrl NEAR JSON-RPC endpoint.
 * @returns Provider (views) and account (transactions).
 * @throws When the account or key is unset, or the key is not an `ed25519:` secret.
 */
export function nearClients(rpcUrl: string) {
  const accountId = req("NEAR_ACCOUNT_ID");
  const key = req("NEAR_PRIVKEY").trim();
  if (!key.startsWith("ed25519:")) throw new Error("NEAR_PRIVKEY is not an ed25519: secret key");

  const provider = new JsonRpcProvider({ url: rpcUrl });
  const account = new Account(accountId, provider, KeyPairSigner.fromSecretKey(key as KeyPairString));
  return { provider, account };
}

export type NearClients = ReturnType<typeof nearClients>;

/**
 * Whether a failed NEAR call failed because its work is already done.
 *
 * @param error What near-api-js threw.
 */
export function isDoneOnNear(error: unknown): boolean {
  const text = String((error as Error)?.message ?? error);
  return DONE_PANICS.some((p) => text.includes(p));
}

/**
 * One NEAR transaction at a time. near-api-js reads the access key's nonce per send, so two sends in
 * flight from one key can both take the same nonce and one of them fails.
 *
 * @returns `run(task)`, which waits for every earlier task before starting this one.
 */
export function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(task: () => Promise<T>): Promise<T> {
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return next;
  };
}

/**
 * Redeem an NTT transfer on a NEAR manager for `accountId`, which must hash to the transfer's `to`.
 * The 0.01 NEAR covers a first-time recipient's token registration and the replay entry; the rest is
 * refunded.
 *
 * @param clients The signing account.
 * @param manager The NEAR NTT manager.
 * @param vaa The signed VAA.
 * @param accountId The recipient.
 * @returns The transaction hash.
 */
export async function complete(
  clients: NearClients,
  manager: string,
  vaa: Buffer,
  accountId: string,
): Promise<string> {
  const outcome = await clients.account.signAndSendTransaction({
    receiverId: manager,
    actions: [
      actions.functionCall(
        "complete",
        { vaa: vaa.toString("hex"), account_id: accountId },
        teraToGas(150),
        nearToYocto("0.01"),
      ),
    ],
    waitUntil: "FINAL",
  });

  // A NEAR transaction can succeed while a receipt downstream of it fails; a retry then lands on
  // `AlreadyExecuted` and is acked, with this failure in the log.
  const failed = outcome.receipts_outcome.filter(
    (r) => typeof r.outcome.status === "object" && "Failure" in r.outcome.status,
  );
  if (failed.length > 0) {
    throw new Error(
      `complete ${outcome.transaction.hash}: receipt failed — ${JSON.stringify(
        failed.map((r) => ({ executor: r.outcome.executor_id, status: r.outcome.status })),
      )}`,
    );
  }
  return outcome.transaction.hash;
}
