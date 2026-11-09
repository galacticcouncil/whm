import { createHash } from "node:crypto";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/**
 * Base58 (Bitcoin alphabet) to bytes.
 *
 * @param text Base58 text.
 * @returns The decoded bytes.
 * @throws On a character outside the alphabet.
 */
export function decodeBase58(text: string): Buffer {
  let n = 0n;
  for (const c of text) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error(`not base58: ${text}`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  for (; n > 0n; n /= 256n) bytes.unshift(Number(n % 256n));
  for (const c of text) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

/**
 * Bytes to base58 (Bitcoin alphabet).
 *
 * @param bytes Input.
 * @returns Base58 text.
 */
export function encodeBase58(bytes: Buffer): string {
  let out = "";
  for (let n = BigInt(`0x${bytes.toString("hex") || "0"}`); n > 0n; n /= 58n) {
    out = ALPHABET[Number(n % 58n)] + out;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/**
 * Base58check payload, verified.
 *
 * @param text Base58check text.
 * @returns The payload without its checksum, or null on bad base58 or a bad checksum.
 */
export function decodeBase58Check(text: string): Buffer | null {
  let raw: Buffer;
  try {
    raw = decodeBase58(text);
  } catch {
    return null;
  }
  if (raw.length < 5) return null;
  const body = raw.subarray(0, raw.length - 4);
  return checksum(body).equals(raw.subarray(raw.length - 4)) ? body : null;
}

/**
 * Base58check encoding of a payload.
 *
 * @param body The payload.
 * @returns Base58check text.
 */
export function encodeBase58Check(body: Buffer): string {
  return encodeBase58(Buffer.concat([body, checksum(body)]));
}

/**
 * The base58check checksum: the first 4 bytes of a double SHA-256.
 *
 * @param body The payload.
 * @returns 4 bytes.
 */
function checksum(body: Buffer): Buffer {
  const once = createHash("sha256").update(body).digest();
  return createHash("sha256").update(once).digest().subarray(0, 4);
}
