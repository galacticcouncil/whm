import { parseAbiItem } from "viem";

/** Source EVM chain — BasejumpEmitter. Names no sender, which is why ingest resolves one. */
export const BridgeInitiatedEvt = parseAbiItem(
  "event BridgeInitiated(address indexed asset, uint256 amount, uint256 fee, uint16 destChain, bytes32 recipient, uint64 transferSequence, uint64 messageSequence)",
);

/** Hydration landing — paid straight out of the pool. */
export const TransferExecutedEvt = parseAbiItem(
  "event TransferExecuted(address indexed sourceAsset, address indexed destAsset, bytes32 indexed recipient, uint256 amount)",
);

/** Hydration landing — the pool was short, so the payout waits. */
export const TransferQueuedEvt = parseAbiItem(
  "event TransferQueued(uint256 indexed id, address indexed sourceAsset, address destAsset, bytes32 recipient, uint256 amount)",
);

export const PendingTransferFulfilledEvt = parseAbiItem(
  "event PendingTransferFulfilled(uint256 indexed id, address indexed sourceAsset, address destAsset, bytes32 recipient, uint256 amount)",
);
