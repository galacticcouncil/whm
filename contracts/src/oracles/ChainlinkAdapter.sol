// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Exposes a Chainlink feed as the single 18-dec `uint256` that `OracleEmitter` reads.
/// @dev Immutable on purpose: the emitter that points here is renounced, so the binding is final.
contract ChainlinkAdapter {
    IAggregatorV3 public immutable feed;
    /// @notice Max age of the feed's last round in seconds; 0 disables the check.
    uint256 public immutable maxAge;

    error InvalidFeed(address feed);
    error UnsupportedDecimals(uint8 decimals);
    error InvalidAnswer(int256 answer);
    error StaleAnswer(uint256 updatedAt, uint256 maxAge);

    constructor(address _feed, uint256 _maxAge) {
        if (_feed == address(0)) revert InvalidFeed(_feed);
        feed = IAggregatorV3(_feed);
        maxAge = _maxAge;
    }

    // ─── Core ────────────────────────────────────────────────────

    /// @notice Latest answer scaled to 18 decimals.
    function latestRate() external view returns (uint256) {
        uint8 decimals = feed.decimals();
        if (decimals > 18) revert UnsupportedDecimals(decimals);

        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) revert InvalidAnswer(answer);
        if (maxAge != 0 && updatedAt + maxAge < block.timestamp) revert StaleAnswer(updatedAt, maxAge);

        // casting to 'uint256' is safe because answer > 0 is checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint256(answer) * 10 ** (18 - decimals);
    }
}
