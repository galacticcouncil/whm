import { privateKey } from "../config.js";

/**
 * The signing key, 0x-prefixed.
 *
 * @returns The key viem needs.
 * @throws When not 32 bytes of hex.
 * @remarks viem requires the prefix where ethers did not, so bare-hex keys carried over from an
 *          earlier deployment are accepted and normalized rather than rejected at startup.
 */
export function signingKey(): `0x${string}` {
  const raw = privateKey();
  const hex = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`PRIVKEY is not a 32-byte hex private key (got ${hex.length} hex chars)`);
  }
  return `0x${hex.toLowerCase()}`;
}
