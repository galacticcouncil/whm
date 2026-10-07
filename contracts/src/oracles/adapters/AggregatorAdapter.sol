// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IAggregator} from "../interfaces/IAggregator.sol";

/// @notice Exposes an answer-only feed (no rounds, e.g. Hydration's EMA oracle precompile) as the
///         single 18-dec `uint256` that `OracleEmitter` reads.
/// @dev Immutable on purpose: the emitter that points here is renounced, so the binding is final.
contract AggregatorAdapter {
    IAggregator public immutable feed;

    error InvalidFeed(address feed);
    error UnsupportedDecimals(uint8 decimals);
    error InvalidAnswer(int256 answer);

    constructor(address _feed) {
        if (_feed == address(0)) revert InvalidFeed(_feed);
        feed = IAggregator(_feed);
    }

    // ─── Core ────────────────────────────────────────────────────

    /// @notice Latest answer scaled to 18 decimals.
    function latestRate() external view returns (uint256) {
        uint8 decimals = feed.decimals();
        if (decimals > 18) revert UnsupportedDecimals(decimals);

        int256 answer = feed.latestAnswer();
        if (answer <= 0) revert InvalidAnswer(answer);

        // casting to 'uint256' is safe because answer > 0 is checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint256(answer) * 10 ** (18 - decimals);
    }
}
