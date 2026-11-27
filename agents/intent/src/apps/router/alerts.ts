import { duration, link, short, type Embed } from "@whm/common/discord";

import { APP_NAME, BALANCE_FLOOR, config } from "./config";
import type { QuoteCheck } from "./floor";
import type { Watched } from "./watch";

/**
 * A trade for an alert: shortened, linked to its scan page when `SCAN_URL` is set.
 *
 * @param path The terms' `auth_path`.
 * @returns The markdown.
 */
export function trade(path: string): string {
  return link(short(path), config.scanUrl && `${config.scanUrl}/v2/trade/${path}`);
}

/** Why a swap is waiting — the details of a `waiting to swap` alert. */
export const waiting = {
  /**
   * @param error 1Click's failure.
   * @returns The reason.
   */
  quoteFailing: (error: string): string => `1Click quote failing — ${error}`,
  quoteKey: "1Click signed its quote with a key the router does not accept",
  /**
   * @param c The quote's least output, and what the order's price and the hard floor need.
   * @returns The reason.
   */
  floor: (c: Extract<QuoteCheck, { reason: "floor" }>): string =>
    `Price under the floor — 1Click quotes at least ${c.minOut}, the router needs ${c.needRate > c.needFloor ? c.needRate : c.needFloor}`,
};

/** Every alert the router bot posts, worded in one place; the worker and app only decide when. */
export const alerts = {
  /**
   * @param keys The router's `quote_keys`.
   * @returns The alert.
   */
  quoteKey: (keys: string[]): Embed => ({
    component: APP_NAME,
    action: "quote key not accepted",
    level: "error",
    details: "1Click's quotes verify against none of the router's keys — no order swaps until the router accepts 1Click's key (set_quote_keys)",
    fields: [["Router keys", keys.map((k) => short(k, 14, 6)).join(", ") || "none"]],
  }),

  /**
   * @param failingMs How long every 1Click call has gone unanswered.
   * @param lastError The last failure.
   * @returns The alert.
   */
  oneClickDown: (failingMs: number, lastError?: string): Embed => ({
    component: APP_NAME,
    action: "1click unreachable",
    level: "error",
    details: "No quote and no swap; ETH waits in A and swaps once 1Click is back, inside the order's price window",
    fields: [
      ["Failing for", duration(failingMs)],
      ["Last error", lastError ?? "—"],
    ],
  }),

  /**
   * @param sinceMs How long since a pass last completed.
   * @returns The alert.
   */
  passFailing: (sinceMs: number): Embed => ({
    component: APP_NAME,
    action: "no pass completing",
    level: "error",
    details: "Scan or the NEAR RPC unreachable? Nothing is swapped, delivered or refunded meanwhile",
    fields: [["Last pass", `${duration(sinceMs)} ago`]],
  }),

  /**
   * @param balance The bot account's NEAR, yocto.
   * @returns The alert.
   */
  balanceLow: (balance: bigint): Embed => ({
    component: APP_NAME,
    action: "balance low",
    level: "warn",
    details: "Every signature and payout is paid from it — top it up",
    fields: [
      ["Account", link(config.account, `https://nearblocks.io/address/${config.account}`)],
      ["Balance", `${Number(balance) / 1e24} NEAR`],
      ["Floor", `${Number(BALANCE_FLOOR) / 1e24} NEAR`],
    ],
  }),

  /**
   * @param path The terms' `auth_path`.
   * @param w What `watch` found stuck.
   * @returns The alert.
   */
  watched: (path: string, w: Watched): Embed => ({
    component: APP_NAME,
    action: w.action,
    level: "warn",
    details: w.details,
    fields: [["Trade", trade(path)], ...w.fields],
  }),
};
