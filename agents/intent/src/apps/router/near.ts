import { Account, actions, JsonRpcProvider, KeyPairSigner, PublicKey, teraToGas, type KeyPairString } from "near-api-js";

import { config } from "./config";

type TxOutcome = Awaited<ReturnType<Account["signAndSendTransaction"]>>;

/** `router.get_config()`, as far as the bot reads it. */
export interface RouterConfig {
  mpc_signer: string;
  intents: string;
  eth_token: string;
  params: {
    price_validity: number;
    min_quote_slippage_bps: number;
    transfer_validity: number;
    max_order_shortfall_bps: number;
    min_refund: string;
  };
}

const provider = new JsonRpcProvider({ url: config.rpcNear });
const bot = new Account(config.account, provider, KeyPairSigner.fromSecretKey(config.privateKey as KeyPairString));

/**
 * Call a view method.
 *
 * @param contractId The contract.
 * @param method View method name.
 * @param args JSON arguments.
 * @returns The method's JSON result.
 */
async function view<T>(contractId: string, method: string, args: object = {}): Promise<T> {
  return (await provider.callFunction({ contractId, method, args: args as Record<string, unknown> })) as T;
}

/** @returns The router's configuration. */
export function routerConfig(): Promise<RouterConfig> {
  return view<RouterConfig>(config.router, "get_config");
}

/**
 * `A` for a derivation path — the implicit account of the key `v1.signer` derives for the router.
 *
 * @param mpcSigner `v1.signer`.
 * @param path The terms' `auth_path`, `0x` + lowercase hex.
 * @returns `A`'s account id.
 */
export async function deriveAccount(mpcSigner: string, path: string): Promise<string> {
  const key = await view<string>(mpcSigner, "derived_public_key", {
    path,
    predecessor: config.router,
    domain_id: 1,
  });
  return Buffer.from(PublicKey.fromString(key).data).toString("hex");
}

/**
 * `A`'s balances on `intents.near`.
 *
 * @param intents The verifier.
 * @param account `A`.
 * @param tokens Ledger ids.
 * @returns Balances, in the order of `tokens`.
 */
export async function balances(intents: string, account: string, tokens: string[]): Promise<bigint[]> {
  const r = await view<string[]>(intents, "mt_batch_balance_of", { account_id: account, token_ids: tokens });
  return r.map(BigInt);
}

/** One `intent_signed` event's data — `signed_data` is the publishable MultiPayload. */
export type Signed = { signed_data: unknown } & Record<string, unknown>;

/**
 * Have the router sign, with the signer's 1 yocto, and collect every payload it signed — `settle`
 * signs a delivery and a refund apart, and the transaction's result shows only one of them.
 *
 * @param method The router method.
 * @param args Its arguments.
 * @returns Every `intent_signed` event's data, in receipt order.
 * @throws With the failed receipts when nothing was signed — a refusal lands in a callback, after
 *         the transaction itself succeeded.
 */
export async function signAll(method: string, args: object): Promise<Signed[]> {
  const outcome = await bot.signAndSendTransaction({
    receiverId: config.router,
    actions: [actions.functionCall(method, args, teraToGas(300), 1n)],
    waitUntil: "FINAL",
  });
  const signed: Signed[] = outcome.receipts_outcome
    .flatMap((r) => r.outcome.logs)
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice("EVENT_JSON:".length)))
    .filter((e) => e.standard === "whm-intent-router" && e.event === "intent_signed")
    .flatMap((e) => e.data);
  if (!signed.length) throw new Error(`${method} ${outcome.transaction.hash}: nothing signed — ${failures(outcome)}`);
  return signed;
}

/**
 * Have the router sign one payload: `swap`, `deliver` or `refund`.
 *
 * @param method The router method.
 * @param args Its arguments.
 * @returns The `intent_signed` event's data.
 * @throws As `signAll`.
 */
export async function sign(method: string, args: object): Promise<Signed> {
  return (await signAll(method, args))[0];
}

/**
 * @param outcome A final execution outcome.
 * @returns Its failed receipts, as JSON.
 */
function failures(outcome: TxOutcome): string {
  return JSON.stringify(
    outcome.receipts_outcome
      .filter((r) => typeof r.outcome.status === "object" && "Failure" in r.outcome.status)
      .map((r) => r.outcome.status),
  );
}
