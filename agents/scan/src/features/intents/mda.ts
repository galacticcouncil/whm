import { blake2b } from "@noble/hashes/blake2b";
import { hexToBytes, bytesToHex, getAddress } from "viem";

/**
 * Compute a Hydration EVM account's multilocation-derivative account (MDA, an H160) on Moonbeam —
 * the account every genuine Hydration intent bridges from. Mirrors the on-chain
 * `DerivedAccount.deriveSiblingEvm(HydrationConsts.PARA_ID, emitter)` in
 * contracts/src/utils/DerivedAccount.sol: a Hydration EVM account's substrate identity is its
 * truncated form `b"ETH\0" ++ h160 ++ 8×0` (an AccountId32), so the MDA uses the AccountId32
 * derivation — blake2b-256 of `"SiblingChain" ++ compact(paraId) ++ compact(43) ++ "AccountId32" ++ id32`,
 * truncated to 20 bytes. Deriving it (vs configuring it) means new emitters need no extra config.
 */
const HYDRATION_PARA_ID = 2034;
const TEXT = new TextEncoder();

/** SCALE compact-u32 encoding (covers the single-, two-, and four-byte modes we need). */
function compactU32(v: number): Uint8Array {
  if (v < 64) return Uint8Array.of(v << 2);
  if (v < 16384) {
    const x = (v << 2) | 1;
    return Uint8Array.of(x & 0xff, (x >> 8) & 0xff);
  }
  const x = (v << 2) | 2;
  return Uint8Array.of(x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff, (x >> 24) & 0xff);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Derive the Moonbeam MDA (lowercased H160) for a Hydration EVM emitter address.
 *
 * @param emitter the IntentEmitter's Hydration EVM address
 * @returns the emitter's MDA on Moonbeam
 */
export function deriveEmitterMda(emitter: string): `0x${string}` {
  const h160 = hexToBytes(getAddress(emitter)); // 20 bytes
  const id32 = concat(Uint8Array.of(0x45, 0x54, 0x48, 0x00), h160, new Uint8Array(8));
  const preimage = concat(
    TEXT.encode("SiblingChain"),
    compactU32(HYDRATION_PARA_ID),
    compactU32(43), // len("AccountId32") + 32
    TEXT.encode("AccountId32"),
    id32,
  );
  return bytesToHex(blake2b(preimage, { dkLen: 32 }).slice(0, 20)).toLowerCase() as `0x${string}`;
}
