import { parseAbi } from "viem";

/**
 * OracleReceiver — the destination call and the reverts worth naming in logs.
 *
 * The CheckedOracle errors reach us through `IManagedOracle.setPrice` and are declared in
 * galacticcouncil/money-market, not this repo — if their signatures change the selectors drift and
 * these silently stop matching.
 */
export const receiverAbi = parseAbi([
  "function receiveMessage(bytes vaa) external",
  // OracleReceiver's own
  "error StalePriceUpdate(bytes32 assetId, uint64 incomingTimestamp, uint64 latestTimestamp)",
  "error OracleNotSet(bytes32 assetId)",
  // CheckedOracle's, raised through setPrice
  "error PriceDeviationTooLarge(int256 price, int256 checkPrice, uint256 deviationBps, uint256 maxDiffBps)",
  "error CheckPriceUnavailable()",
  "error NotPriceSetter()",
  "error InvalidPrice()",
]);
