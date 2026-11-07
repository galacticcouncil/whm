import { fromSeq, opt, optNum, rpc } from "../../config";
import { WORMHOLE } from "../../chains";

/**
 * Engine namespace. LOAD-BEARING — every Redis key derives from it. Renaming orphans the existing
 * queue and missed-VAA cursors, and the worker then rescans from FROM_SEQUENCE. Overridable only so
 * a second deployment can run beside the live one.
 */
export const APP_NAME = opt("APP_NAME", "basejump-relayer");

export const RPC_HYDRATION = rpc("hydration", "https://hydration-rpc.n.dwellir.com");

/**
 * Cold-start floor; ignored once a safeSequence exists in Redis. The emitter counts fast-path
 * messages alone, from zero, so nothing below the floor is ever a payout to skip.
 */
export const FROM_SEQUENCE = {
  [WORMHOLE.ethereum]: fromSeq("ethereum"),
  [WORMHOLE.base]: fromSeq("base"),
};

/**
 * Failures are transient by construction — a shortfall queues, a receiver the TC has not upgraded
 * or armed yet reverts — so the budget spans a governance window. A job that exhausts it parks in
 * `failed` and nothing replays it. Backoff is min(2^attempt * base, max), attempt from 1:
 * 2, 4, 8, 16, 30, 30, … min — 250 attempts is about five days.
 */
export const RETRIES = 250;
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 30 * 60_000;

/** Node's timer limit: a longer delay is silently clamped to 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Below this a "positive" value is a typo, and the timer would fire back to back. */
const MIN_TIMER_MS = 1_000;

/**
 * A number of `unit`s from env, as milliseconds, from `MIN_TIMER_MS` (1 s) to `MAX_TIMER_MS`
 * (about 24.8 days). Fails at startup on anything else, so a typo cannot turn into a timer that
 * fires constantly or an alert that never does.
 */
function positiveMs(name: string, fallback: number, unitMs: number): number {
  const v = optNum(name, fallback);
  const ms = v * unitMs;
  if (!Number.isFinite(ms) || ms < MIN_TIMER_MS || ms > MAX_TIMER_MS) {
    throw new Error(
      `${name} must be between 1 s and about 24.8 days, got ${process.env[name]}`,
    );
  }
  return v * unitMs;
}

/**
 * Queued payouts. A landing short of float queues a payout instead of paying it; the app pays the
 * queue head as soon as the pool covers it (see payouts.ts). It checks after every delivery it
 * handles and on this timer, so a refill by the settlement leg is picked up within one interval.
 */
export const QUEUED_PAYOUT_POLL_MS = positiveMs("QUEUED_PAYOUT_POLL_SECONDS", 60, 1_000);

/**
 * Alert once when the same queued payout has stayed at the head this long. A short float clears in
 * about one settlement (~13-25 min), so 30 min means something else is wrong: the pool is not
 * being refilled, or the head can never be paid and is holding every later payout behind it.
 */
export const QUEUED_PAYOUT_ALERT_MS = positiveMs("QUEUED_PAYOUT_ALERT_MINUTES", 30, 60_000);

/** How long a pass waits for its own `fulfillPending` receipt before leaving it to the next one. */
export const QUEUED_PAYOUT_RECEIPT_TIMEOUT_MS = 120_000;
