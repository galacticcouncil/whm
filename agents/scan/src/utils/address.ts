import { AccountId } from "polkadot-api";

const ETH_ACCOUNT_PREFIX = "0x45544800";

/**
 * Convert a bytes32 recipient as emitted on-chain into its canonical display form:
 * h160 (`0x…40`) when it's either left-padded with 12 zero bytes (EVM convention)
 * or wrapped as Hydration's `"ETH\0" + h160 + 8 zero bytes`; otherwise ss58-encoded.
 *
 * @param bytes32 the raw 32-byte recipient (hex string)
 * @returns the canonical h160 or ss58 string
 */
export function normalizeRecipient(bytes32: string): string {
  const s = bytes32.toLowerCase();
  if (s.startsWith(ETH_ACCOUNT_PREFIX)) {
    return "0x" + s.slice(ETH_ACCOUNT_PREFIX.length, ETH_ACCOUNT_PREFIX.length + 40);
  }
  const bytes = Buffer.from(s.slice(2), "hex");
  return AccountId(0).dec(new Uint8Array(bytes));
}

/**
 * Right-trim a bytes32 (left-padded) EVM address to its canonical lowercase h160.
 *
 * @param bytes32 the 32-byte hex string (a 20-byte address left-padded with 12 zero bytes)
 * @returns the lowercase `0x…40` address
 */
export function bytes32ToAddress(bytes32: string): `0x${string}` {
  const s = bytes32.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  return `0x${s.slice(24)}` as `0x${string}`;
}
