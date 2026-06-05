// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title Moonbeam precompile interfaces
/// @notice ABIs for Moonbeam's built-in precompiles.

/// @notice Batch precompile (0x...0808) — runs multiple calls atomically.
/// @dev A zero gasLimit entry forwards all remaining gas to that sub-call.
interface IBatch {
    function batchAll(address[] memory to, uint256[] memory value, bytes[] memory callData, uint64[] memory gasLimit)
        external;
}
