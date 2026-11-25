import { PublicKey, type JsonRpcProvider } from "near-api-js";

import { view } from "../utils";

/** NEAR Intents' verifier — where every intents account's balances live. */
export const INTENTS = "intents.near";

/** The MPC signer that derives the accounts a contract signs for. */
export const MPC_SIGNER = "v1.signer";

/** `v1.signer`'s Ed25519 domain — what an intents account signs with. */
const DOMAIN_ED25519 = 1;

/**
 * The intents account a contract controls for a derivation path: the implicit account of the
 * Ed25519 key `v1.signer` derives for (`predecessor`, `path`). Only `predecessor` can have that key
 * sign, so only it can move the account's funds.
 *
 * @param provider A NEAR provider
 * @param predecessor The contract the key is derived for
 * @param path The derivation path — for the intents router, its terms' `auth_path`, `0x` + hex
 * @returns The account's id: the key's 32 bytes as hex
 */
export async function deriveAccount(provider: JsonRpcProvider, predecessor: string, path: string): Promise<string> {
  const key = await view<string>(provider, MPC_SIGNER, "derived_public_key", {
    path,
    predecessor,
    domain_id: DOMAIN_ED25519,
  });
  return Array.from(PublicKey.fromString(key).data, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * An intents account's balances.
 *
 * @param provider A NEAR provider
 * @param account The intents account
 * @param tokens Ledger ids, e.g. `nep141:eth.omft.near`
 * @returns Each token's balance
 */
export async function balances(
  provider: JsonRpcProvider,
  account: string,
  tokens: string[],
): Promise<Record<string, bigint>> {
  const r = await view<string[]>(provider, INTENTS, "mt_batch_balance_of", { account_id: account, token_ids: tokens });
  return Object.fromEntries(tokens.map((t, i) => [t, BigInt(r[i] ?? 0)]));
}
