import { parseAbiItem } from "viem";

// Hydration — IntentEmitter(Wtt).BridgeInitiated (the swap+bridge entry)
export const BridgeInitiatedEvt = parseAbiItem(
  "event BridgeInitiated(bytes32 indexed intentId, address indexed caller, uint32 indexed assetIn, uint256 amountIn, uint256 ethOut, address intentDepositAddress)",
);

// Moonbeam — Wormhole core LogMessagePublished (the payload-3 TokenBridge publish, in-flight leg)
export const LogMessagePublishedEvt = parseAbiItem(
  "event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)",
);

// Ethereum — IntentReceiver.redeem outcomes
export const IntentForwardedEvt = parseAbiItem(
  "event IntentForwarded(bytes32 indexed intentId, address indexed asset, address indexed depositAddress, uint256 amount)",
);

export const RelayFeePaidEvt = parseAbiItem(
  "event RelayFeePaid(bytes32 indexed intentId, address indexed relayer, uint256 fee)",
);
