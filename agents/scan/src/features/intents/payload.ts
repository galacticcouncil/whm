import { decodeAbiParameters, hexToBigInt, hexToNumber, sliceHex, type Hex } from "viem";

/**
 * A Wormhole TokenBridge `TransferWithPayload` (payload type 3) message body, as carried in a
 * `LogMessagePublished` event. Field offsets follow the TokenBridge wire format.
 */
export interface TokenBridgeTransfer {
  payloadId: number;
  amount: bigint; // Wormhole 8-decimal normalized amount
  tokenAddress: Hex; // bytes32
  tokenChain: number;
  to: Hex; // bytes32 recipient (the IntentReceiver, left-padded)
  toChain: number;
  fromAddress: Hex; // bytes32 sender
  inner: Hex; // arbitrary application payload
}

/**
 * Parse a Wormhole message body as a TokenBridge payload-3 transfer.
 *
 * @param payload the raw `LogMessagePublished` payload bytes
 * @returns the decoded transfer, or null if it isn't a payload-3 / is too short
 */
export function parseTransferWithPayload(payload: Hex): TokenBridgeTransfer | null {
  const byteLen = (payload.length - 2) / 2;
  if (byteLen < 133) return null;
  if (hexToNumber(sliceHex(payload, 0, 1)) !== 3) return null;
  return {
    payloadId: 3,
    amount: hexToBigInt(sliceHex(payload, 1, 33)),
    tokenAddress: sliceHex(payload, 33, 65),
    tokenChain: hexToNumber(sliceHex(payload, 65, 67)),
    to: sliceHex(payload, 67, 99),
    toChain: hexToNumber(sliceHex(payload, 99, 101)),
    fromAddress: sliceHex(payload, 101, 133),
    inner: sliceHex(payload, 133),
  };
}

export interface IntentPayload {
  intentId: Hex;
  depositAddress: Hex;
  maxRelayFee: bigint;
}

/**
 * Decode the intent application payload `(bytes32 intentId, address depositAddress, uint256 maxRelayFee)`.
 *
 * @param inner the 96-byte inner payload from a TokenBridge transfer
 * @returns the decoded intent fields, or null if the payload isn't exactly 96 bytes
 */
export function decodeIntentPayload(inner: Hex): IntentPayload | null {
  if ((inner.length - 2) / 2 !== 96) return null;
  const [intentId, depositAddress, maxRelayFee] = decodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
    inner,
  );
  return {
    intentId: intentId as Hex,
    depositAddress: depositAddress as Hex,
    maxRelayFee: maxRelayFee as bigint,
  };
}
