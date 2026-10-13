// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IAggregator — answer-only price feed, no rounds
/// @dev The legacy Chainlink AggregatorInterface reads. Hydration's EMA oracle precompile
///      (`0x000001…`) implements only these two — `latestRoundData()` reverts "unknown selector".
interface IAggregator {
    function decimals() external view returns (uint8);

    function latestAnswer() external view returns (int256);
}
