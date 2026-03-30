// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface IBasejumpBase {
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

    event TransferProcessed(address indexed sourceAsset, uint256 amount, bytes32 indexed recipient);

    // ─── Errors ──────────────────────────────────────────────────

    error BasejumpLandingNotSet(uint16 chainId);
    error ZeroAmount();
    error AmountTooLowForFee(uint256 amount, uint256 fee);

    // ─── Functions ───────────────────────────────────────────────

    function completeTransfer(bytes memory vaa) external;

    function quoteFee(address asset) external view returns (uint256 fee);
}
