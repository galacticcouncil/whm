import { pad, type Address } from "viem";

/**
 * NTT transceiver payload parsing. Shared by every app that reads an NTT settlement, whichever
 * direction it travels.
 *
 * TransceiverMessage wire format, as far as the manager's message id:
 *
 *   offset  size  field
 *        0     4  prefix
 *        4    32  sourceNttManagerAddress
 *       36    32  recipientNttManagerAddress
 *       68     2  nttManagerPayload length
 *       70    32  id
 *      102    32  sender
 *      134     2  transfer payload length
 *      136     4  NTT prefix
 *      140     1  decimals
 *      141     8  amount, trimmed to `decimals`
 *
 * `id` is `bytes32(uint256(sequence))`, so the uint64 sits in its last 8 bytes. This mirrors
 * `NttPayload.settlementOf` in contracts/src/ntt, which is what IntentReceiver re-reads on-chain.
 */

/** Only transfers carry this prefix; the same emitter also publishes init/peer broadcasts. */
export const NTT_TRANSFER_PREFIX = "9945ff10";

const RECIPIENT_MANAGER_OFFSET = 36;
const SEQUENCE_OFFSET = 70 + 24;
const DECIMALS_OFFSET = 140;
const AMOUNT_OFFSET = 141;

/**
 * Whether a transceiver message is a transfer rather than a setup broadcast.
 *
 * @param payload Raw transceiver payload bytes.
 */
export function isNttTransfer(payload: Buffer): boolean {
  return payload.subarray(0, 4).toString("hex") === NTT_TRANSFER_PREFIX;
}

/**
 * The NTT manager's sequence for a settlement.
 *
 * This is the key a settlement and its forwarding instruction share. It is not a Wormhole sequence —
 * those are per-emitter and unrelated.
 *
 * @param payload Raw transceiver payload bytes.
 */
export function settlementSequence(payload: Buffer): bigint {
  return payload.readBigUInt64BE(SEQUENCE_OFFSET);
}

/**
 * What a settlement releases, scaled out of NTT's trimmed representation.
 *
 * The instruction does not carry an amount — the receiver reads it here — so this is the only place
 * off-chain that knows an order's size. Mirrors `IntentReceiver`, which rejects any other precision
 * rather than guessing at the scale.
 *
 * @param payload Raw transceiver payload bytes.
 * @param decimals Precision the destination expects, 18 for native ETH.
 * @returns The amount in the destination's own units.
 * @throws When the settlement is trimmed to a precision the caller did not expect.
 */
export function settlementAmount(payload: Buffer, decimals: number): bigint {
  const trimmedTo = payload.readUInt8(DECIMALS_OFFSET);
  if (trimmedTo > decimals) {
    throw new Error(`settlement trimmed to ${trimmedTo}dp, cannot scale to ${decimals}dp`);
  }
  return payload.readBigUInt64BE(AMOUNT_OFFSET) * 10n ** BigInt(decimals - trimmedTo);
}

/**
 * Whether a settlement is addressed to a given destination NTT manager.
 *
 * One transceiver emitter serves one manager per token, but a relayer subscribing to several routes
 * still has to tell them apart before submitting.
 *
 * @param payload Raw transceiver payload bytes.
 * @param manager Expected destination NttManager address.
 */
export function isForManager(payload: Buffer, manager: Address): boolean {
  const recipient = payload
    .subarray(RECIPIENT_MANAGER_OFFSET, RECIPIENT_MANAGER_OFFSET + 32)
    .toString("hex");
  return recipient === pad(manager, { size: 32 }).slice(2).toLowerCase();
}
