import { createHash } from "node:crypto";

import { actions, teraToGas, type Account, type JsonRpcProvider } from "near-api-js";

export type TxOutcome = Awaited<ReturnType<Account["signAndSendTransaction"]>>;

/** NEP-297 event, as logged with an `EVENT_JSON:` prefix. */
export interface NearEvent {
  standard: string;
  version: string;
  event: string;
  data: unknown;
}

/**
 * Calls a contract method in its own transaction and waits for the whole receipt tree.
 *
 * A successful transaction does not mean every receipt succeeded — check `receiptFailures`.
 *
 * @param account The signing account
 * @param contractId The contract to call
 * @param method Method name
 * @param args JSON arguments
 * @param opts `deposit` in yocto (default 0), `gas` (default 100 TGas)
 * @returns The final execution outcome
 */
export async function call(
  account: Account,
  contractId: string,
  method: string,
  args: object,
  opts: { deposit?: bigint; gas?: bigint } = {},
): Promise<TxOutcome> {
  const { deposit = 0n, gas = teraToGas(100) } = opts;
  return account.signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.functionCall(method, args, gas, deposit)],
    waitUntil: "FINAL",
  });
}

/**
 * Calls a view method.
 *
 * @param provider A NEAR provider
 * @param contractId The contract to query
 * @param method View method name
 * @param args JSON arguments
 * @returns The method's JSON result
 */
export async function view<T>(
  provider: JsonRpcProvider,
  contractId: string,
  method: string,
  args: object = {},
): Promise<T> {
  return (await provider.callFunction({ contractId, method, args: args as Record<string, unknown> })) as T;
}

/**
 * Every NEP-297 event logged anywhere in the transaction's receipt tree.
 *
 * @param outcome A final execution outcome
 * @param standard Keep only this standard (e.g. `whm-ntt`, `wormhole`)
 * @returns The parsed events, in receipt order
 */
export function events(outcome: TxOutcome, standard?: string): NearEvent[] {
  return outcome.receipts_outcome
    .flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice("EVENT_JSON:".length)) as NearEvent)
    .filter((e) => !standard || e.standard === standard);
}

/**
 * Receipts that failed, with the account they ran on — a transaction can succeed while a callback
 * downstream of it fails.
 *
 * @param outcome A final execution outcome
 * @returns `{ executor, failure }` per failed receipt
 */
export function receiptFailures(outcome: TxOutcome): { executor: string; failure: unknown }[] {
  return outcome.receipts_outcome
    .filter((r) => typeof r.outcome.status === "object" && "Failure" in r.outcome.status)
    .map((r) => ({
      executor: r.outcome.executor_id,
      failure: (r.outcome.status as { Failure: unknown }).Failure,
    }));
}

/**
 * Throws if any receipt in the transaction failed. A NEAR transaction can succeed while a
 * cross-contract call inside it fails, so a caller that only checks the transaction would treat a
 * half-done action as done.
 *
 * @param label What the transaction was, for the error
 * @param outcome Its final execution outcome
 * @returns The same outcome
 */
export function checked(label: string, outcome: TxOutcome): TxOutcome {
  const failures = receiptFailures(outcome);
  if (failures.length > 0) {
    throw new Error(`${label}: receipt failed — ${JSON.stringify(failures)}`);
  }
  return outcome;
}

/**
 * A NEAR account on the Wormhole wire — `sha256(account_id)`, the digest the NEAR core uses for
 * emitters and the NTT contract uses for managers, senders, tokens and recipients.
 *
 * @param accountId A NEAR account id
 * @returns 32 bytes as 64 hex chars, no `0x`
 */
export function accountHash(accountId: string): string {
  return createHash("sha256").update(accountId).digest("hex");
}
