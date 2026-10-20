import { Account, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";

export type TxOutcome = Awaited<ReturnType<Account["signAndSendTransaction"]>>;

/** NEP-297 event, as logged with an `EVENT_JSON:` prefix. */
export interface NearEvent {
  standard: string;
  version: string;
  event: string;
  data: unknown;
}

/**
 * A NEAR account that signs with a single key.
 *
 * @param provider The provider it sends through.
 * @param accountId The signing account.
 * @param privateKey Its `ed25519:` secret key.
 * @returns The account.
 * @throws When the key is not an `ed25519:` secret.
 */
export function signer(provider: JsonRpcProvider, accountId: string, privateKey: string): Account {
  if (!privateKey.startsWith("ed25519:")) throw new Error("NEAR key is not an ed25519: secret key");
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(privateKey as KeyPairString));
}

/**
 * Call a view method.
 *
 * @param provider A NEAR provider.
 * @param contractId The contract to query.
 * @param method View method name.
 * @param args JSON arguments.
 * @returns The method's JSON result.
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
 * Every NEP-297 event of one standard logged in the transaction's receipt tree.
 *
 * @param outcome A final execution outcome.
 * @param standard The standard to keep.
 * @returns The parsed events, in receipt order.
 */
export function events(outcome: TxOutcome, standard: string): NearEvent[] {
  return outcome.receipts_outcome
    .flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice("EVENT_JSON:".length)) as NearEvent)
    .filter((e) => e.standard === standard);
}

/**
 * Throw when any receipt in the transaction failed — a NEAR transaction can succeed while a receipt
 * downstream of it fails.
 *
 * @param label What the transaction was, for the error.
 * @param outcome Its final execution outcome.
 * @returns The same outcome.
 */
export function checked(label: string, outcome: TxOutcome): TxOutcome {
  const failed = outcome.receipts_outcome.filter(
    (r) => typeof r.outcome.status === "object" && "Failure" in r.outcome.status,
  );
  if (failed.length > 0) {
    const detail = failed.map((r) => ({ executor: r.outcome.executor_id, status: r.outcome.status }));
    throw new Error(`${label} ${outcome.transaction.hash}: receipt failed — ${JSON.stringify(detail)}`);
  }
  return outcome;
}
