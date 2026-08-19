// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title INttManager — minimal NTT manager surface used by Basejump
/// @dev Hand-written: the pinned Solidity SDK ships no NTT interface. Signatures match
///      hydration-ntt evm/src/interfaces/{INttManager,IManagerBase}.sol at NTT_COMMIT
///      0f19d43f7ae88adf36e62364d4157db8da7a68ee (deployment version 2.0.0).
interface INttManager {
    /// @notice Locks (hub) or burns (spoke) `amount` and emits a transfer message.
    /// @dev This 3-arg overload hardcodes `shouldQueue = false`, so an outbound
    ///      rate-limit breach REVERTS rather than queuing. Basejump depends on that:
    ///      it is what keeps a fast-path payout from ever outrunning its settlement.
    function transfer(
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient
    ) external payable returns (uint64 msgId);

    /// @return perTransceiver Price for each enabled transceiver
    /// @return total Total delivery price — the value `transfer` must be sent with
    /// @dev `transceiverInstructions` must be `hex"00"` (zero-count prefix). Passing
    ///      empty bytes reverts LengthMismatch(0,1) = 0xab8b67c6.
    function quoteDeliveryPrice(
        uint16 recipientChain,
        bytes memory transceiverInstructions
    ) external view returns (uint256[] memory perTransceiver, uint256 total);

    function token() external view returns (address);

    function tokenDecimals() external view returns (uint8);

    function isPaused() external view returns (bool);

    function getCurrentOutboundCapacity() external view returns (uint256);
}
