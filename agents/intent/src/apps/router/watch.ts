import { formatEther } from "viem";

import { duration } from "@whm/common/discord";

const BPS = 10_000n;

/**
 * ETH for people: `0.000665 ETH`.
 *
 * @param wei The amount.
 * @returns It in ETH, to six decimals.
 */
export function eth(wei: bigint): string {
  return `${Number(formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ETH`;
}

export interface WatchInput {
  nowMs: number;
  deadlineMs: number;
  /** `A`'s ETH. */
  eth: bigint;
  minRefund: bigint;
  maxOrderShortfallBps: bigint;
  /** The newest order of the terms, if any. */
  order?: {
    seq: string;
    amount: bigint;
    /** When the forwarder paid it into 1Click's deposit address; absent until then. */
    forwardedAtMs?: number;
    /** Swapped already. */
    filled: boolean;
  };
  /** Why the bot's last swap attempt for these terms stopped before signing, if it did. */
  blocked?: string;
  creditAlertMs: number;
  swapAlertMs: number;
  refundAlertMs: number;
}

/** One condition worth a person's look, keyed so it is raised once and cleared when it ends. */
export interface Watched {
  /** Unique within the terms. */
  key: string;
  /** What is happening, lower case — the alert's `[action]`. */
  action: string;
  /** One sentence on what it means. */
  details: string;
  fields: [string, string][];
}

/**
 * What about one set of terms is stuck without anything having failed: an order's ETH not credited
 * to `A` (it sits with 1Click/POA), an order credited but not swapped, or ETH still in `A` as the
 * deadline nears (it will be refunded).
 *
 * @param i The terms' state now, and the thresholds.
 * @returns The conditions that hold now.
 */
export function watch(i: WatchInput): Watched[] {
  const out: Watched[] = [];
  const o = i.order;
  if (o && !o.filled && o.forwardedAtMs !== undefined) {
    const since = i.nowMs - o.forwardedAtMs;
    const credited = i.eth * BPS >= o.amount * (BPS - i.maxOrderShortfallBps);
    if (!credited && since >= i.creditAlertMs) {
      out.push({
        key: `credit:${o.seq}`,
        action: "deposit not credited",
        details: "The order's ETH reached 1Click's deposit address but not A — it sits with 1Click/POA",
        fields: [
          ["Order", o.seq],
          ["Amount", eth(o.amount)],
          ["In A", eth(i.eth)],
        ],
      });
    }
    if (credited && since >= i.swapAlertMs) {
      out.push({
        key: `swap:${o.seq}`,
        action: "waiting to swap",
        details: i.blocked ?? "Credited to A, but the bot has not swapped it",
        fields: [
          ["Order", o.seq],
          ["In A", eth(i.eth)],
        ],
      });
    }
  }
  const left = i.deadlineMs - i.nowMs;
  if (left >= 0 && left <= i.refundAlertMs && i.eth > 0n && i.eth >= i.minRefund) {
    out.push({
      key: "refund",
      action: "refund coming",
      details: "ETH still unswapped in A near the deadline — it will be refunded to the terms' refund address",
      fields: [
        ["Deadline in", duration(left)],
        ["In A", eth(i.eth)],
      ],
    });
  }
  return out;
}
