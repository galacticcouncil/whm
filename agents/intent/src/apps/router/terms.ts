/** The terms fields the bot decides on. Layout: `contracts/src/intents-v2/IntentCodec.sol`. */
export interface Terms {
  maxFillMultiplier: bigint;
  minDelivery: bigint;
  /** Unix ms. */
  deadlineMs: number;
  /** Intents ledger id, e.g. `nep141:zec.omft.near`. */
  destinationAsset: string;
}

/**
 * Read the fields the bot needs from encoded terms. Everything else is the router's to check.
 *
 * @param bytes The encoded terms.
 * @returns The fields.
 */
export function decodeTerms(bytes: Buffer): Terms {
  const d = bytes[117];
  if (bytes[0] !== 1 || d === undefined || bytes.length < 118 + d) throw new Error("unknown terms layout");
  return {
    maxFillMultiplier: BigInt(bytes[55]!),
    minDelivery: BigInt(`0x${bytes.subarray(72, 88).toString("hex")}`),
    deadlineMs: Number(bytes.readBigUInt64BE(88)) * 1000,
    destinationAsset: bytes.subarray(118, 118 + d).toString("utf8"),
  };
}
