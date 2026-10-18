/**
 * NTT transceiver payload parsing.
 *
 * Mirrors `TransceiverStructs.parseTransceiverMessage` + `parseNttManagerMessage` +
 * `parseNativeTokenTransfer`. `contracts/src/ntt/NttPayload.sol` reads the same bytes on-chain as
 * far as the manager's message id; this reads the rest, because an indexer wants the amount and the
 * recipient too.
 *
 * Wire format:
 *
 *   TransceiverMessage        NttManagerMessage           NativeTokenTransfer
 *     0   4  prefix             0   32  id                  0   4  prefix
 *     4  32  sourceManager     32   32  sender              4   1  decimals
 *    36  32  recipientManager  64    2  payload length      5   8  amount
 *    68   2  payload length    66   ..  payload            13  32  sourceToken
 *    70  ..  payload                                       45  32  to
 *                                                          77   2  toChain
 */

import { keccak256 } from "viem";

const TRANSCEIVER_PREFIX = "0x9945ff10";
const NTT_PREFIX = "0x994e5454";

export interface NttTransfer {
  /**
   * What NTT settles delivery on, `keccak256(sourceChainId ++ managerMessage)`.
   *
   * Computed here rather than read off the destination, because nothing on the destination emits it
   * beside the VAA it belongs to — the transceiver's `ReceivedMessage` carries the VAA hash, which
   * is a different value. Deriving it at the source means the row already knows its digest before
   * any delivery event arrives, and the legs that carry nothing else can simply find it.
   */
  digest: `0x${string}`;
  /**
   * The NTT manager's sequence — `NttManager.transfer`'s return value. Not a Wormhole sequence. Null
   * where the message id is not one: Solana's is its outbox item's key.
   */
  sequence: bigint | null;
  /**
   * Who called the manager, as the 32 bytes the message carries: an EVM caller left-padded, a NEAR
   * one as `sha256(account_id)`. A contract riding the rail — an emitter, a connector — is named
   * here rather than its user.
   */
  sender: `0x${string}`;
  sourceManager: `0x${string}`;
  recipientManager: `0x${string}`;
  /** Trimmed to `decimals` places, which is the precision the rail actually carries. */
  amount: bigint;
  decimals: number;
  sourceToken: `0x${string}`;
  /** Destination recipient, as the 32 bytes the message carries. */
  to: `0x${string}`;
  toChain: number;
}

/**
 * Read a transceiver payload.
 *
 * @param payload Hex of a transceiver VAA's payload.
 * @param sourceChainId Wormhole id of the chain that published it — part of the digest preimage.
 * @returns The transfer, or null when the message is not one — the same emitter publishes peer and
 *          init broadcasts, and none of those describe a transfer.
 */
export function parseNttTransfer(payload: string, sourceChainId: number): NttTransfer | null {
  const b = Buffer.from(payload.replace(/^0x/, ""), "hex");
  if (b.length < 70) return null;
  if (hex(b, 0, 4) !== TRANSCEIVER_PREFIX) return null;

  const sourceManager = hex(b, 4, 32);
  const recipientManager = hex(b, 36, 32);
  const managerLen = b.readUInt16BE(68);
  const manager = b.subarray(70, 70 + managerLen);
  if (manager.length < 66) return null;

  // `id` is bytes32(uint256(sequence)), so the uint64 sits in its last eight bytes — wherever the
  // rest is zero. Solana's is a key, all 32 bytes of it.
  const sequence = manager.subarray(0, 24).every((x) => x === 0)
    ? manager.readBigUInt64BE(24)
    : null;
  const innerLen = manager.readUInt16BE(64);
  const inner = manager.subarray(66, 66 + innerLen);
  if (inner.length < 79 || hex(inner, 0, 4) !== NTT_PREFIX) return null;

  // abi.encodePacked(sourceChainId, encodedNttManagerMessage) — and the manager message is already
  // encoded exactly as NTT encodes it, so the slice is the preimage verbatim.
  const chain = Buffer.alloc(2);
  chain.writeUInt16BE(sourceChainId);
  const digest = keccak256(new Uint8Array(Buffer.concat([chain, manager])));

  return {
    digest,
    sequence,
    sender: hex(manager, 32, 32),
    sourceManager: address(sourceManager),
    recipientManager: address(recipientManager),
    decimals: inner.readUInt8(4),
    amount: inner.readBigUInt64BE(5),
    sourceToken: address(hex(inner, 13, 32)),
    to: hex(inner, 45, 32),
    toChain: inner.readUInt16BE(77),
  };
}

/**
 * Slice a buffer as lowercase hex.
 *
 * @param b The buffer.
 * @param at Byte offset.
 * @param len Byte length.
 */
function hex(b: Buffer, at: number, len: number): `0x${string}` {
  return `0x${b.subarray(at, at + len).toString("hex")}`;
}

/**
 * Right-trim a left-padded bytes32 to its h160.
 *
 * @param bytes32 The 32-byte value.
 */
function address(bytes32: string): `0x${string}` {
  return `0x${bytes32.replace(/^0x/, "").slice(24)}`;
}
