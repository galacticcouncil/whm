import { parseAbi } from "viem";

/** IntentReceiver — the destination call and the reverts worth naming in logs. */
export const receiverAbi = parseAbi([
  "function processOrder(bytes nttVaa, bytes instructionVaa, uint256 feeRequested) external",
  "error AlreadyRedeemed()",
  "error SequenceMismatch(uint64 instructed, uint64 settled)",
  "error SettlementNotReleased(uint64 sequence)",
  "error UnexpectedTrim(uint8 decimals)",
  "error FeeExceedsCeiling()",
  "error UnauthorizedEmitter(uint16 chainId, bytes32 emitter)",
]);

/**
 * Wormhole core bridge log. Only `sender` is indexed, which is enough to pick our emitter's messages
 * out of a receipt without knowing the core bridge's own address.
 */
export const coreBridgeAbi = parseAbi([
  "event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)",
]);

/**
 * The emitter's forwarding instruction, as published beside each settlement:
 * `abi.encode(sequence, depositAddress, maxRelayFee)`. No amount — the receiver reads that off the
 * settlement, so an instruction has no size to over-state.
 */
export const instructionAbi = [
  { type: "uint64" },
  { type: "address" },
  { type: "uint256" },
] as const;
