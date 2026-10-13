import { isAddress, type Address } from "viem";

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
 * A required environment variable holding an EVM address.
 *
 * @param name Variable name.
 * @returns The checksummed-or-not address, validated.
 * @throws When unset or not an address.
 */
export function requiredAddress(name: string): Address {
  const v = required(name);
  if (!isAddress(v)) throw new Error(`${name} is not a valid address: ${v}`);
  return v;
}

/**
 * An optional environment variable parsed as a bigint.
 *
 * @param name Variable name.
 * @param fallback Value when unset.
 * @returns The parsed value, or the fallback.
 */
export function optionalBigint(name: string, fallback: bigint): bigint {
  const v = process.env[name];
  return v ? BigInt(v) : fallback;
}
