import { parseAbiItem } from "viem";

/** Hydration — IntentDispatcher: an order bridged and published, with its terms in full. */
export const OrderPublishedEvt = parseAbiItem(
  "event OrderPublished(bytes32 indexed authPath, uint64 indexed seq, address indexed caller, address depositAddress, uint128 amount, uint128 outPerIn, uint64 messageSequence, bytes terms)",
);

/** Ethereum — IntentForwarder.processOrder delivered the settlement and deposited it to POA. */
export const OrderForwardedEvt = parseAbiItem(
  "event OrderForwarded(uint64 indexed transferSequence, address indexed depositAddress, uint256 amount)",
);

/** Ethereum — same transaction as the forward; what the relayer took for doing it. */
export const RelayFeePaidEvt = parseAbiItem(
  "event RelayFeePaid(uint64 indexed transferSequence, address indexed relayer, uint256 fee)",
);
