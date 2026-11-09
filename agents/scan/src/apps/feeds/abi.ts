import { parseAbiItem } from "viem";

/** `OracleReceiver` — an update verified, written, and passed to the oracle. `timestamp` is the VAA's. */
export const PriceReceivedEvt = parseAbiItem(
  "event PriceReceived(bytes32 indexed assetId, uint256 price, uint64 timestamp)",
);
