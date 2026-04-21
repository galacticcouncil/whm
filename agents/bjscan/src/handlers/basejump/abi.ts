import { parseAbiItem } from "viem";

export const BridgeInitiatedEvt = parseAbiItem(
  "event BridgeInitiated(address indexed asset, uint256 amount, uint256 fee, uint16 destChain, bytes32 recipient, uint64 transferSequence, uint64 messageSequence)",
);
