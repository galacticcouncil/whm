// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface IInstaTransfer {
    // ─── Events ──────────────────────────────────────────────────

    event TransferExecuted(address indexed sourceAsset, address indexed destAsset, bytes32 indexed recipient, uint256 amount);
    event TransferQueued(uint256 indexed id, address indexed sourceAsset, address destAsset, bytes32 recipient, uint256 amount);
    event PendingTransferFulfilled(uint256 indexed id, address indexed sourceAsset, address destAsset, bytes32 recipient, uint256 amount);
    event Withdrawn(address indexed asset, uint256 amount, address indexed to);
    event DestAssetUpdated(address indexed sourceAsset, address indexed destAsset);

    // ─── Errors ──────────────────────────────────────────────────

    error NotOwner();
    error NotAuthorizedBridge();
    error DispatchFailed();
    error ERC20TransferFailed();
    error NoPendingTransfers();
    error InsufficientBalance();
    error AssetNotConfigured(address sourceAsset);

    // ─── Core ────────────────────────────────────────────────────

    function transfer(address sourceAsset, uint256 amount, bytes32 recipient) external;
    function fulfillPending() external;

    // ─── Views ───────────────────────────────────────────────────

    function owner() external view returns (address);
    function authorizedBridges(address bridge) external view returns (bool);
    function destAssetFor(address sourceAsset) external view returns (address);
    function pendingHead() external view returns (uint256);
    function pendingTail() external view returns (uint256);
    function pendingTransfers(uint256 id) external view returns (address sourceAsset, uint256 amount, bytes32 recipient);

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external;
    function setAuthorizedBridge(address bridge, bool enabled) external;
    function setDestAsset(address sourceAsset, address destAsset) external;
    function withdraw(address asset, uint256 amount, address to) external;
}
