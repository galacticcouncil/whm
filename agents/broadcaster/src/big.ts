/**
 * Returns `true` if the relative difference between `current` and `last`
 * exceeds the given `threshold` (e.g. 0.05 = 5%).
 *
 * Always returns `true` when `last` is zero (first observation).
 */
export function hasChangedBeyondThreshold(
  current: bigint,
  last: bigint,
  threshold: number,
): boolean {
  if (last === 0n) return true;
  const diff = current > last ? current - last : last - current;
  // Compare: diff / last > threshold  =>  diff * 10000 > last * (threshold * 10000)
  const scaledThreshold = BigInt(Math.round(threshold * 10000));
  return diff * 10000n > last * scaledThreshold;
}
