const HOUR = 3_600;

/** Cap on the hours walked, so a long-dead feed costs a bounded loop. Far beyond any threshold. */
const MAX_HOURS = 24 * 30;

/**
 * Whether US-equity 24/5 feeds are paused at a given time.
 *
 * Chainlink posts no rounds from ~Fri 16:00 UTC to Mon 00:00 UTC, heartbeat included. Holidays are
 * not modelled — they read as open, so a long weekend can warn.
 *
 * @param unixSec Time to test, unix seconds.
 * @returns True inside the weekly closed window.
 */
export function isMarketClosed(unixSec: number): boolean {
  const d = new Date(unixSec * 1_000);
  const day = d.getUTCDay();
  return day === 6 || day === 0 || (day === 5 && d.getUTCHours() >= 16);
}

/**
 * Seconds of open-market time between two instants.
 *
 * A round posted Friday afternoon is not stale on Sunday — no rounds exist to be missed — so the
 * age that matters excludes the closed window. The window opens and closes on the hour, so walking
 * hour-aligned segments is exact.
 *
 * @param fromSec Start, unix seconds — the round's `updatedAt`.
 * @param toSec End, unix seconds — now.
 * @returns Open-market seconds elapsed, capped at {@link MAX_HOURS}.
 */
export function marketAge(fromSec: number, toSec: number): number {
  let open = 0;
  let hours = 0;
  for (let t = fromSec; t < toSec && hours < MAX_HOURS; hours++) {
    const next = Math.min(toSec, (Math.floor(t / HOUR) + 1) * HOUR);
    if (!isMarketClosed(t)) open += next - t;
    t = next;
  }
  return open;
}
