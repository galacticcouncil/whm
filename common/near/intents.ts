import { PublicKey, type JsonRpcProvider } from "near-api-js";

import { view } from "./utils";

/** NEAR Intents' verifier — where every intents account's balances live. */
export const INTENTS = "intents.near";

/** The MPC signer that derives the accounts a contract signs for. */
export const MPC_SIGNER = "v1.signer";

/** 1Click Swap API (1CS). */
export const ONE_CLICK_API = "https://1click.chaindefuser.com";

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

/** A standing pass-through: its deposit address on a chain, and the 1Click account behind it. */
export interface PassThrough {
  /** Where to deposit, on the requested chain. */
  address: string;
  /** 1Click's intents account the address credits, before forwarding. */
  internal: string;
}

/**
 * A reusable 1CS deposit address that forwards whatever arrives, as itself, to an intents account:
 * a standing `ANY_INPUT` quote, `1cs_v1:any` → `1cs_v1:original`, with the account as recipient and
 * refund. Every deposit lands on 1Click's account for the quote first and is forwarded within
 * seconds; the chain's bridge takes its usual time to see the deposit.
 *
 * @param apiKey The 1Click partner key — standing quotes need one
 * @param account The intents account to forward to
 * @param chain The chain to deposit on, as 1CS names it (`eth`, `base`, …)
 * @returns The address on `chain`, and 1Click's account behind it
 * @throws When 1CS refuses the quote, or names no address on `chain`
 */
export async function passThrough(apiKey: string, account: string, chain = "eth"): Promise<PassThrough> {
  const res = await fetch(`${ONE_CLICK_API}/v0/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      dry: false,
      swapType: "ANY_INPUT",
      originAsset: "1cs_v1:any",
      depositType: "INTENTS",
      destinationAsset: "1cs_v1:original",
      amount: "0",
      slippageTolerance: 50,
      recipient: account,
      recipientType: "INTENTS",
      refundTo: account,
      refundType: "INTENTS",
      // The deadline 1CS's docs give for a standing address.
      deadline: "2038-01-01T00:00:00.000Z",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json()) as {
    quote?: { depositAddress: string; chainDepositAddresses?: { blockchain: string; address: string }[] };
  };
  if (!res.ok || !body.quote) throw new Error(`1cs ${res.status}: ${JSON.stringify(body)}`);
  const address = body.quote.chainDepositAddresses?.find((c) => c.blockchain === chain)?.address;
  if (!address) throw new Error(`1cs names no ${chain} address: ${JSON.stringify(body.quote)}`);
  return { address, internal: body.quote.depositAddress };
}
