// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IBasejumpEmitter — source end of a direct EVM → Hydration corridor
interface IBasejumpEmitter {
    // ─── Events ──────────────────────────────────────────────────

    event BridgeInitiated(
        address indexed asset,
        uint256 amount,
        uint256 fee,
        uint16 destChain,
        bytes32 recipient,
        uint64 transferSequence,
        uint64 messageSequence
    );

    // ─── Errors ──────────────────────────────────────────────────

    error ZeroAmount();
    error ZeroAmountReceived();
    error AmountTooLowForFee(uint256 amount, uint256 fee);
    error SettlementRouteNotSet(address asset);
    error LandingNotSet();

    // ─── Functions ───────────────────────────────────────────────

    /// @notice Bridge `amount` of `asset` to `recipient` on Hydration on two rails: an NTT
    ///         settlement carrying the gross amount to the landing pool, and an instant-finality
    ///         message carrying the net amount that the pool pays out against.
    /// @dev Settlement precedes publication and cannot queue, so a payout instruction can never
    ///      outrun its replenishment.
    /// @param data Opaque bytes forwarded end-to-end into the delivery (see IBasejumpPayload).
    ///        Empty for a plain transfer.
    /// @return transferSequence The NTT manager's sequence for the settlement leg.
    /// @return messageSequence The Wormhole core sequence for the fast-path message.
    function bridgeViaWormhole(
        address asset,
        uint256 amount,
        bytes32 recipient,
        bytes memory data
    ) external payable returns (uint64 transferSequence, uint64 messageSequence);

    /// @notice The fixed fee withheld from `asset`, retained by the landing pool on delivery.
    function quoteFee(address asset) external view returns (uint256 fee);
}
