// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IAggregatorV3 — Chainlink price feed, round-based read
/// @dev The subset of Chainlink's AggregatorV3Interface that AggregatorV3Adapter reads.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
