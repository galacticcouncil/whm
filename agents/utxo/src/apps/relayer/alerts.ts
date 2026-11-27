import { duration, link, short, type Embed } from "@whm/common/discord";

import { APP_NAME, BALANCE_FLOOR } from "./config";
import type { Withdrawal } from "./store";

/** The alerts' component. */
const COMPONENT = `utxo ${APP_NAME}`;

/** Each chain's base unit, and where its addresses are looked up — as scan links them. */
const CHAIN_UNIT: Record<string, string> = { zcash: "zat", bitcoin: "sat" };
const CHAIN_EXPLORER: Record<string, string> = {
  zcash: "https://blockchair.com/zcash/address/",
  bitcoin: "https://blockchair.com/bitcoin/address/",
};

/**
 * @param chain The chain's name.
 * @returns Its base unit.
 */
export function unit(chain: string): string {
  return CHAIN_UNIT[chain] ?? "units";
}

/**
 * A destination address for an alert: shortened, linked to its explorer.
 *
 * @param chain The chain's name.
 * @param a The address.
 * @returns The markdown.
 */
export function address(chain: string, a: string): string {
  return link(short(a, 6), CHAIN_EXPLORER[chain] && `${CHAIN_EXPLORER[chain]}${a}`);
}

/**
 * A NEAR account for an alert, linked to NearBlocks: an implicit one shortened, a named one whole.
 *
 * @param account The account.
 * @returns The markdown.
 */
export function nearAccount(account: string): string {
  return link(/^[0-9a-f]{64}$/.test(account) ? short(account, 6) : account, `https://nearblocks.io/address/${account}`);
}

/**
 * What an incident shows about the withdrawal that failed.
 *
 * @param chain The chain's name.
 * @param held What `A` held, in the chain's base unit.
 * @param to The destination address.
 * @param account `A`.
 * @returns The fields.
 */
export function incidentFields(chain: string, held: bigint, to: string, account: string): [string, string][] {
  return [
    ["Amount", `${held} ${unit(chain)}`],
    ["To", address(chain, to)],
    ["Via", nearAccount(account)],
  ];
}

/** Every alert the UTXO relayer posts, worded in one place; the worker only decides when. */
export const alerts = {
  /**
   * @param sinceMs How long since a pass last completed.
   * @param error The pass's failure.
   * @returns The alert.
   */
  passFailing: (sinceMs: number, error: string): Embed => ({
    component: COMPONENT,
    action: "no pass completing",
    level: "error",
    details: "Redis or the NEAR RPC unreachable? Nothing is withdrawn meanwhile",
    fields: [
      ["Last pass", `${duration(sinceMs)} ago`],
      ["Last error", error.slice(0, 300)],
    ],
  }),

  /**
   * @param account The relaying account.
   * @param balance Its NEAR, yocto.
   * @returns The alert.
   */
  balanceLow: (account: string, balance: bigint): Embed => ({
    component: COMPONENT,
    action: "balance low",
    level: "warn",
    details: "Every withdrawal's signature and relay is paid from it — top it up",
    fields: [
      ["Account", nearAccount(account)],
      ["Balance", `${Number(balance) / 1e24} NEAR`],
      ["Floor", `${Number(BALANCE_FLOOR) / 1e24} NEAR`],
    ],
  }),

  /**
   * @param w The record open too long.
   * @param nowMs Now, unix ms.
   * @returns The alert.
   */
  stuck: (w: Withdrawal, nowMs: number): Embed => {
    const status = w.lastError ?? "waiting for the settlement";
    return {
      component: COMPONENT,
      action: "withdrawal stuck",
      level: "warn",
      details: status.charAt(0).toUpperCase() + status.slice(1),
      fields: [
        ["Open", duration(nowMs - w.createdAt)],
        ["Record", short(`${w.chain}:${w.sequence}`, 20, 6)],
        ["To", address(w.chain, w.address)],
        ["Via", nearAccount(w.account)],
      ],
    };
  },
};
