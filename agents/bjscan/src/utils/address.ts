import { AccountId } from "polkadot-api";

const ETH_ACCOUNT_PREFIX = "0x45544800";

/**
 * Convert a bytes32 recipient as emitted on-chain into its canonical display form:
 * h160 (`0x…40`) when it's either left-padded with 12 zero bytes (EVM convention)
 * or wrapped as Hydration's `"ETH\0" + h160 + 8 zero bytes`; otherwise ss58-encoded.
 */
export function normalizeRecipient(bytes32: string): string {
  const s = bytes32.toLowerCase();
  if (s.startsWith(ETH_ACCOUNT_PREFIX)) {
    return "0x" + s.slice(ETH_ACCOUNT_PREFIX.length, ETH_ACCOUNT_PREFIX.length + 40);
  }
  const bytes = Buffer.from(s.slice(2), "hex");
  return AccountId(0).dec(new Uint8Array(bytes));
}
