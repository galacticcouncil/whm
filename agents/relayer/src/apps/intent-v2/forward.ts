import { getAddress, type Address } from "viem";

/** `IntentCodec.FORWARD_VERSION`. */
const FORWARD_VERSION = 1;

/** `IntentCodec.FORWARD_SIZE`: version 1 | depositAddress 20 | maxRelayFee 16. */
const FORWARD_SIZE = 37;

export interface Forward {
  /** POA's deposit address for the order's NEAR account. */
  depositAddress: Address;
  /** The most the relayer may claim, in wei. */
  maxRelayFee: bigint;
}

/**
 * The forwarding instruction the dispatcher put in a transfer's payload, read as
 * `IntentCodec.decodeForward` reads it — exactly 37 bytes of version 1, or nothing.
 *
 * @param payload The transfer's payload.
 * @returns The instruction, or null when the payload is not one.
 */
export function forwardOf(payload: Buffer): Forward | null {
  if (payload.length !== FORWARD_SIZE || payload[0] !== FORWARD_VERSION) return null;
  return {
    depositAddress: getAddress(`0x${payload.subarray(1, 21).toString("hex")}`),
    maxRelayFee: BigInt(`0x${payload.subarray(21, 37).toString("hex")}`),
  };
}
