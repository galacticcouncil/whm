/**
 * A required environment variable.
 *
 * @param name Variable name.
 * @returns Its value.
 * @throws When unset or empty.
 */
export function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name}`);
  return v;
}

/**
 * An optional environment variable with a fallback.
 *
 * @param name Variable name.
 * @param fallback Value when unset.
 * @returns The set value, or the fallback.
 */
export function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

/**
 * An optional environment variable parsed as a number.
 *
 * @param name Variable name.
 * @param fallback Value when unset.
 * @returns The parsed value, or the fallback.
 */
export function optionalNumber(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}
