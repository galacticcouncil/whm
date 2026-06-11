import { parseAbiItem } from "viem";

/**
 * Wormhole Core Bridge `LogMessagePublished` event — emitted on every `publishMessage`.
 * `sender` is the emitter contract (use it to pick the right message when a tx publishes
 * more than one, e.g. a TokenBridge transfer alongside a fast-path VAA).
 */
export const LOG_MESSAGE_PUBLISHED = parseAbiItem(
  "event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)",
);
