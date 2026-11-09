import { createHash } from "node:crypto";

import { T1, T3 } from "./consts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();

/** RIPEMD-160 of SHA-256 — what a transparent address commits to. */
export const hash160 = (b: Buffer) => createHash("ripemd160").update(sha256(b)).digest();

/**
 * A transparent address from its 22 bytes — version then hash, as the emitter logs it.
 *
 * @param payload `0x` + 44 hex, or the bytes.
 * @returns `t1…` / `t3…`, or null for a version that is not a mainnet transparent one.
 */
export function encodeAddress(payload: string | Buffer): string | null {
  const b = typeof payload === "string" ? Buffer.from(payload.replace(/^0x/, ""), "hex") : payload;
  if (b.length !== 22) return null;
  const version = b.readUInt16BE(0);
  if (version !== T1 && version !== T3) return null;
  const full = Buffer.concat([b, sha256(sha256(b)).subarray(0, 4)]);
  let n = BigInt(`0x${full.toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of full) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/**
 * The address a 20-byte hash names under a version.
 *
 * @param version `T1` or `T3`.
 * @param hash The key or script hash.
 */
export function addressOf(version: number, hash: Buffer): string {
  const v = Buffer.alloc(2);
  v.writeUInt16BE(version);
  return encodeAddress(Buffer.concat([v, hash]))!;
}
