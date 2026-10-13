/**
 * The call a relayer will build, sized before it exists.
 *
 * `maxRelayFee` is committed at `placeOrder` time, so neither VAA has been signed yet and nothing
 * can be estimated against a node. What *is* known is the shape: a VAA's wire size is fixed by its
 * framing, and both payloads this path carries are fixed-length. So the envelope is derived rather
 * than guessed, and it tracks a guardian-set change instead of going stale.
 *
 * See [docs/intents/relay-fee.md](../../../../../docs/intents/relay-fee.md).
 */

/** version(1) + guardianSetIndex(4) + numSignatures(1) */
const VAA_HEADER = 6;

/** guardianIndex(1) + signature(65) */
const VAA_SIGNATURE = 66;

/** timestamp(4) nonce(4) emitterChain(2) emitterAddress(32) sequence(8) consistencyLevel(1) */
const VAA_BODY_HEADER = 51;

/** Gas per calldata byte, EIP-2028. */
const ZERO_BYTE_GAS = 4n;
const NONZERO_BYTE_GAS = 16n;

/**
 * Share of calldata bytes that are zero.
 *
 * Signatures are entropy, but offsets, length words, padded addresses and the ABI-encoded payload
 * are mostly zero — measured at ~20% across observed deliveries. Assuming all-nonzero instead costs
 * +0.9% on the total, so this does not warrant more precision.
 */
const ZERO_BYTE_RATIO = 0.2;

/**
 * A signed VAA's size on the wire.
 *
 * @param signatures Guardian signatures it carries.
 * @param payloadBytes The emitter's own bytes.
 * @returns Total bytes.
 */
export function vaaBytes(signatures: number, payloadBytes: number): number {
  return VAA_HEADER + VAA_SIGNATURE * signatures + VAA_BODY_HEADER + payloadBytes;
}

/**
 * Size of one dynamic `bytes` argument once ABI-encoded: a 32-byte length word, then the body
 * padded up to a word boundary.
 *
 * @param bytes Length of the argument.
 * @returns Bytes it occupies in the call's tail.
 */
export function abiBytesArg(bytes: number): number {
  return 32 + Math.ceil(bytes / 32) * 32;
}

/**
 * Calldata size of a call: selector, one head word per argument, then each dynamic tail.
 *
 * @param staticArgs Arguments passed by value (each one word).
 * @param dynamicArgs Byte lengths of the dynamic arguments.
 * @returns Total calldata bytes.
 */
export function calldataBytes(staticArgs: number, dynamicArgs: number[]): number {
  const head = 4 + 32 * (staticArgs + dynamicArgs.length);
  return head + dynamicArgs.reduce((sum, len) => sum + abiBytesArg(len), 0);
}

/**
 * Gas charged for carrying calldata.
 *
 * EIP-7623's floor is not modelled: it binds only when a transaction is calldata-heavy relative to
 * what it executes, and this one executes ~610k against a floor near 101k.
 *
 * @param bytes Total calldata bytes.
 * @returns Gas.
 */
export function calldataGas(bytes: number): bigint {
  const zero = BigInt(Math.round(bytes * ZERO_BYTE_RATIO));
  return zero * ZERO_BYTE_GAS + (BigInt(bytes) - zero) * NONZERO_BYTE_GAS;
}
