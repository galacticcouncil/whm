import { parseAbiItem } from "viem";

export const TransferExecutedEvt = parseAbiItem(
  "event TransferExecuted(address indexed sourceAsset, address indexed destAsset, bytes32 indexed recipient, uint256 amount)",
);

export const TransferQueuedEvt = parseAbiItem(
  "event TransferQueued(uint256 indexed id, address indexed sourceAsset, address destAsset, bytes32 recipient, uint256 amount)",
);

export const PendingTransferFulfilledEvt = parseAbiItem(
  "event PendingTransferFulfilled(uint256 indexed id, address indexed sourceAsset, address destAsset, bytes32 recipient, uint256 amount)",
);
