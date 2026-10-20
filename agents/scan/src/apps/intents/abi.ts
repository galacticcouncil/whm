import { parseAbiItem } from "viem";

/** Hydration — IntentEmitter.placeOrder. `transferSequence` is the NTT manager's, not Wormhole's. */
export const OrderPlacedEvt = parseAbiItem(
  "event OrderPlaced(uint64 indexed transferSequence, address indexed depositAddress, address indexed caller, uint32 assetIn, uint256 amountIn, uint256 ethOut, uint256 maxRelayFee)",
);

/** Ethereum — IntentReceiver.processOrder delivered the settlement and forwarded it. */
export const OrderProcessedEvt = parseAbiItem(
  "event OrderProcessed(uint64 indexed transferSequence, address indexed depositAddress, uint256 amount)",
);

/** Ethereum — same transaction as the forward; what the relayer took for doing it. */
export const RelayFeePaidEvt = parseAbiItem(
  "event RelayFeePaid(uint64 indexed transferSequence, address indexed relayer, uint256 fee)",
);
