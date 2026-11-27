/** The terms fields the bot decides on. Layout: `contracts/src/intents-v2/IntentCodec.sol`. */
export interface Terms {
  /** How far a fill may sit under the order's own price. */
  maxSlippageBps: bigint;
  maxFillMultiplier: bigint;
  /** The hard floor: destination units per 1e18 wei, whatever the order's price. */
  minOutPerIn: bigint;
  minDelivery: bigint;
  /** Unix ms. */
  deadlineMs: number;
  /** 0 = withdraw to the asset's own chain, 1 = an intents account. */
  recipientKind: number;
  /** Intents ledger id, e.g. `nep141:zec.omft.near`. */
  destinationAsset: string;
  recipient: string;
}

/**
 * Read the fields the bot needs from encoded terms. Everything else is the router's to check.
 *
 * @param bytes The encoded terms.
 * @returns The fields.
 */
export function decodeTerms(bytes: Buffer): Terms {
  const d = bytes[117];
  const r = d === undefined ? undefined : bytes[118 + d];
  if (bytes[0] !== 1 || d === undefined || r === undefined || bytes.length < 119 + d + r) {
    throw new Error("unknown terms layout");
  }
  return {
    maxSlippageBps: BigInt(bytes.readUInt16BE(53)),
    maxFillMultiplier: BigInt(bytes[55]!),
    minOutPerIn: BigInt(`0x${bytes.subarray(56, 72).toString("hex")}`),
    minDelivery: BigInt(`0x${bytes.subarray(72, 88).toString("hex")}`),
    deadlineMs: Number(bytes.readBigUInt64BE(88)) * 1000,
    recipientKind: bytes[96]!,
    destinationAsset: bytes.subarray(118, 118 + d).toString("utf8"),
    recipient: bytes.subarray(119 + d, 119 + d + r).toString("utf8"),
  };
}
