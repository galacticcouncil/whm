import { parseAbiItem } from "viem";

// IIntentReceiver.OrderProcessed — emitted when processOrder delivers the NTT settlement and
// forwards the native ETH to a deposit address (transferSequence, depositAddress are indexed).
// `transferSequence` is the NTT manager's sequence, the key the settlement and its forwarding
// instruction share; it is not a Wormhole sequence.
export const OrderProcessedEvt = parseAbiItem(
  "event OrderProcessed(uint64 indexed transferSequence, address indexed depositAddress, uint256 amount)",
);
