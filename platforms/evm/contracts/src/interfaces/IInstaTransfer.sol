// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface IInstaTransfer {
    // ─── Events ──────────────────────────────────────────────────

    event TransferExecuted(address indexed sourceAsset, address indexed destAsset, bytes32 indexed recipient, uint256 amount);
    event TransferQueued(uint256 indexed id, address indexed sourceAsset, address destAsset, bytes32 recipient, uint256 amount);
    event PendingTransferFulfilled(uint256 indexed id, address indexed sourceAsset, address destAsset, bytes32 recipient, uint256 amount);
    event Withdrawn(address indexed asset, uint256 amount, address indexed to);
    event AllowedAssetPairUpdated(address indexed sourceAsset, address indexed destAsset, bool enabled);

    // ─── Errors ──────────────────────────────────────────────────

    error NotOwner();
    error NotAuthorizedBridge();
    error DispatchFailed();
    error ERC20TransferFailed();
    error PendingTransferNotFound(uint256 id);
    error InsufficientBalance();
    error AssetPairNotAllowed(address sourceAsset, address destAsset);

    // ─── Core ────────────────────────────────────────────────────

    function transfer(address sourceAsset, address destAsset, uint256 amount, bytes32 recipient) external;
    function fulfillPending(uint256 id) external;

    // ─── Views ───────────────────────────────────────────────────

    function owner() external view returns (address);
    function authorizedBridges(address bridge) external view returns (bool);
    function allowedAssetPairs(address sourceAsset, address destAsset) external view returns (bool);
    function nextPendingId() external view returns (uint256);
    function pendingTransfers(uint256 id) external view returns (address sourceAsset, address destAsset, uint256 amount, bytes32 recipient);

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external;
    function setAuthorizedBridge(address bridge, bool enabled) external;
    function setAllowedAssetPair(address sourceAsset, address destAsset, bool enabled) external;
    function withdraw(address asset, uint256 amount, address to) external;
}
