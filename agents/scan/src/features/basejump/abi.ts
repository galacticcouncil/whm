import { parseAbiItem } from "viem";

// Source EVM chains (Base / Ethereum) — Basejump.sol
export const BridgeInitiatedEvt = parseAbiItem(
  "event BridgeInitiated(address indexed asset, uint256 amount, uint256 fee, uint16 destChain, bytes32 recipient, uint64 transferSequence, uint64 messageSequence)",
);

// Hydration landing — BasejumpLanding
export const TransferExecutedEvt = parseAbiItem(
  "event TransferExecuted(address indexed sourceAsset, address indexed destAsset, bytes32 indexed recipient, uint256 amount)",
);

export const TransferQueuedEvt = parseAbiItem(
  "event TransferQueued(uint256 indexed id, address indexed sourceAsset, address destAsset, bytes32 recipient, uint256 amount)",
);

export const PendingTransferFulfilledEvt = parseAbiItem(
  "event PendingTransferFulfilled(uint256 indexed id, address indexed sourceAsset, address destAsset, bytes32 recipient, uint256 amount)",
);
