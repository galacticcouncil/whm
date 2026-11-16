import { bytesToHex, hexToBytes } from "viem";

/** The terms fields worth a column: who they belong to, when they end, where the asset goes. */
export interface Terms {
  owner: `0x${string}`;
  /** Unix seconds. */
  deadline: bigint;
  recipientKind: number;
  refundTo: `0x${string}`;
  destinationAsset: string;
  recipient: string;
}

/** The only layout there is. */
const VERSION = 1;

/** Fixed prefix through `destAssetLen`. */
const HEADER = 118;

/**
 * Read the terms `OrderPublished` carries — layout in `IntentCodec.sol`.
 *
 * The dispatcher encodes nothing its own decoder would refuse, so a failure here means a layout this
 * reader does not know; the row keeps the raw terms either way.
 *
 * @param hex The encoded terms.
 * @returns The fields, or null when they do not parse.
 */
export function decodeTerms(hex: `0x${string}`): Terms | null {
  const b = hexToBytes(hex);
  if (b.length < HEADER + 1 || b[0] !== VERSION) return null;
  const d = b[117]!;
  if (b.length < HEADER + d + 1) return null;
  const r = b[HEADER + d]!;
  if (b.length !== HEADER + d + 1 + r) return null;

  const text = new TextDecoder();
  return {
    owner: bytesToHex(b.subarray(1, 21)),
    deadline: Buffer.from(b.subarray(88, 96)).readBigUInt64BE(),
    recipientKind: b[96]!,
    refundTo: bytesToHex(b.subarray(97, 117)),
    destinationAsset: text.decode(b.subarray(HEADER, HEADER + d)),
    recipient: text.decode(b.subarray(HEADER + d + 1)),
  };
}
