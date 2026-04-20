import { parseAbiItem } from "viem";

export const TransferExecuted = parseAbiItem(
  "event TransferExecuted(address indexed sourceAsset, address indexed destAsset, bytes32 indexed recipient, uint256 amount)",
);

export const TransferQueued = parseAbiItem(
  "event TransferQueued(uint256 indexed id, address indexed sourceAsset, address destAsset, bytes32 recipient, uint256 amount)",
);

export const PendingTransferFulfilled = parseAbiItem(
  "event PendingTransferFulfilled(uint256 indexed id, address indexed sourceAsset, address destAsset, bytes32 recipient, uint256 amount)",
);
