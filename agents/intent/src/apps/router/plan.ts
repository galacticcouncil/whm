const BPS = 10_000n;

export interface PlanInput {
  nowMs: number;
  deadlineMs: number;
  maxFillMultiplier: bigint;
  minDelivery: bigint;
  /** Whether the router can deliver the terms' destination at all — see `delivery` in `utxo.ts`. */
  deliverable: boolean;
  /** The least the router delivers at once: a UTXO route's minimum, else 1. */
  minPayout: bigint;
  /** `A`'s ETH. */
  eth: bigint;
  /** `A`'s destination asset. */
  dest: bigint;
  /** The newest order of these terms published inside the price window, if any. */
  order?: { seq: string; amount: bigint; publishedAtMs: number };
  /** Orders this process has already filled. */
  filled: ReadonlySet<string>;
  priceValidityMs: number;
  maxOrderShortfallBps: bigint;
  minRefund: bigint;
  /** When a close of these terms lets anyone settle, if they were closed. */
  settleAtMs?: number;
  /** A close VAA id past its countdown, once scan has one. */
  closeVaa?: string;
  /** How long after the countdown closed terms are still watched for ETH that lands late. */
  graceMs: number;
}

export type Action =
  | { kind: "swap"; seq: string; amount: bigint }
  | { kind: "deliver" }
  | { kind: "refund" }
  | { kind: "settle"; closeVaa: string }
  | { kind: "wait" }
  | { kind: "drop" };

/**
 * What to do next for one set of terms — the router's own rules, read off `A`'s balances, so a call
 * it would refuse is not sent.
 *
 * Before the deadline: swap when the newest order is still priced and its ETH has landed in `A`
 * (`A`'s whole ETH up to the fill cap — the only size the router accepts); deliver once the
 * destination balance reaches `minDelivery` and `minPayout`. After it: deliver from `minPayout`,
 * refund ETH from `minRefund`, and drop the terms once neither is left — output below `minPayout`
 * stays in `A`.
 *
 * Terms the router cannot deliver — a withdrawal with no route — never swap: their ETH waits for the
 * refund or a settle.
 *
 * Once a close's countdown has passed, a still-priced order swaps first, as before; then one `settle`
 * moves whatever `A` holds — any destination to the recipient, ETH from `minRefund` back. With
 * nothing to move, the terms stay watched for `graceMs` — an order in flight at the close may land
 * late — then drop.
 *
 * @param i The terms, `A`'s balances, the newest order and the router's params.
 * @returns The action.
 */
export function plan(i: PlanInput): Action {
  const payable = i.deliverable && i.dest > 0n && i.dest >= i.minPayout;
  if (i.nowMs > i.deadlineMs) {
    if (payable) return { kind: "deliver" };
    if (i.eth > 0n && i.eth >= i.minRefund) return { kind: "refund" };
    return { kind: "drop" };
  }

  const o = i.order;
  if (
    o &&
    i.deliverable &&
    !i.filled.has(o.seq) &&
    i.nowMs < o.publishedAtMs + i.priceValidityMs &&
    i.eth * BPS >= o.amount * (BPS - i.maxOrderShortfallBps)
  ) {
    const cap = o.amount * i.maxFillMultiplier;
    return { kind: "swap", seq: o.seq, amount: i.eth < cap ? i.eth : cap };
  }

  if (i.settleAtMs !== undefined && i.nowMs >= i.settleAtMs) {
    const held = payable || (i.eth > 0n && i.eth >= i.minRefund);
    if (held) return i.closeVaa ? { kind: "settle", closeVaa: i.closeVaa } : { kind: "wait" };
    return i.nowMs > i.settleAtMs + i.graceMs ? { kind: "drop" } : { kind: "wait" };
  }

  if (payable && i.dest >= i.minDelivery) return { kind: "deliver" };
  return { kind: "wait" };
}
