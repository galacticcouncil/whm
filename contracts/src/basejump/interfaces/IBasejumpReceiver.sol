// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IBasejumpReceiver
/// @notice Contracts that want an atomic post-delivery callback from BasejumpLanding
///         implement this interface. The callback fires only when the Basejump
///         payload carries non-empty `data` — plain transfers (data.length == 0)
///         skip the hook and behave as a regular token transfer to the recipient.
interface IBasejumpReceiver {
    /// @notice Called by an authorized BasejumpLanding atomically with token delivery.
    /// @param asset The asset that was delivered to this contract.
    /// @param amount The amount delivered.
    /// @param data Opaque bytes forwarded from the originating Basejump VAA.
    /// @dev Reverts bubble up and revert the surrounding `completeTransfer` call.
    function onBasejumpReceive(address asset, uint256 amount, bytes calldata data) external;
}
