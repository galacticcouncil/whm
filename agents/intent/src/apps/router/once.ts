import type { Signed } from "./near";

/**
 * A refusal that will not change on a resend: the router declined to sign, the verifier failed the
 * payload's receipts, or 1Click rejected it. Anything else — a timeout, an RPC or HTTP 5xx — never
 * reached a decision, and the same payload may be sent again.
 */
export class Refused extends Error {}

/** One signed payload, and how the log names it. */
export interface Payload {
  signed: Signed;
  label: string;
}

/**
 * What the router signed for one set of terms and the bot has not yet seen through. Every signature
 * costs the bot's account, so a payload is signed once and only ever resent — never signed again.
 */
export interface Pending {
  kind: "swap" | "deliver" | "refund" | "settle";
  /** Not yet executed, in order; a settle signs a delivery and a refund. */
  payloads: Payload[];
  /** When the payloads stop being valid — the router signs each for `transfer_validity`. */
  expiresAt: number;
  /** `A`'s balances when they were signed — see `balanceKey`. */
  balances: string;
  /** A swap's order, marked filled once 1Click takes it. */
  seq?: string;
}

/** Terms the bot stopped signing for, until `A`'s balances move or the bot restarts. */
export interface Parked {
  balances: string;
  reason: string;
}

/**
 * `A`'s balances as one comparable value.
 *
 * @param eth `A`'s ETH.
 * @param dest `A`'s destination asset.
 * @returns The key.
 */
export function balanceKey(eth: bigint, dest: bigint): string {
  return `${eth}:${dest}`;
}

/**
 * What to do with a pending action on this pass.
 *
 * @param p The pending action.
 * @param nowMs Now, unix ms.
 * @param balances `A`'s balances now, from `balanceKey`.
 * @returns `landed` when `A`'s balances moved — it executed, though its send looked failed — so plan
 *          afresh; `resend` while it is still valid; `park` once it expired unexecuted.
 */
export function step(p: Pending, nowMs: number, balances: string): "landed" | "resend" | "park" {
  if (balances !== p.balances) return "landed";
  return nowMs < p.expiresAt ? "resend" : "park";
}
