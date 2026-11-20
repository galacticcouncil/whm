import { base58 } from "@scure/base";

import { view } from "../../chains/near/view";
import { INTENT_V2 } from "../../deployments";
import log from "../../logger";

/** `v1.signer`'s Ed25519 domain — what an intents account signs with. */
const DOMAIN_ED25519 = 1;

/** Each trade's `A`, derived once: it never changes for a path. */
const accounts = new Map<string, Promise<string>>();

/**
 * A trade's `A`: the implicit account of the Ed25519 key `v1.signer` derives for the router and the
 * terms' auth path.
 *
 * @param authPath The terms' auth path, as the router names it.
 * @returns The account id — the key's lowercase hex.
 */
export function tradeAccount(authPath: string): Promise<string> {
  let a = accounts.get(authPath);
  if (!a) {
    a = view<string>("v1.signer", "derived_public_key", {
      path: authPath,
      predecessor: INTENT_V2.router,
      domain_id: DOMAIN_ED25519,
    }).then((key) => Buffer.from(base58.decode(key.replace(/^ed25519:/, ""))).toString("hex"));
    // A failed derivation is retried on the next request rather than cached.
    a.catch(() => accounts.delete(authPath));
    accounts.set(authPath, a);
  }
  return a;
}

/**
 * What a trade's `A` holds of a token right now: the swapped output not yet paid out. Read live, never
 * stored — a payout empties it.
 *
 * @param authPath The terms' auth path.
 * @param token The intents ledger id of the trade's destination asset.
 * @returns `A` and its balance, or null when NEAR cannot be read.
 */
export async function held(authPath: string, token: string): Promise<{ account: string; amount: string } | null> {
  try {
    const account = await tradeAccount(authPath);
    const amount = await view<string>("intents.near", "mt_balance_of", { account_id: account, token_id: token });
    return { account, amount };
  } catch (e) {
    log.warn(`intents-v2: ${authPath} held balance: ${(e as Error).message}`);
    return null;
  }
}
