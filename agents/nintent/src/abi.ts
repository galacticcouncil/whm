import { parseAbiItem } from "viem";

// IIntentReceiver.IntentForwarded — emitted when redeem unwraps the bridged WETH to native ETH and
// forwards it to a OneClick deposit address (intentId, asset, depositAddress are indexed).
export const IntentForwardedEvt = parseAbiItem(
  "event IntentForwarded(bytes32 indexed intentId, address indexed asset, address indexed depositAddress, uint256 amount)",
);
