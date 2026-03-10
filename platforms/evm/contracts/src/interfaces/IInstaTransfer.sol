// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface IInstaTransfer {
    // ─── Events ──────────────────────────────────────────────────

    event TransferExecuted(address indexed asset, address indexed recipient, uint256 amount);
    event TransferQueued(uint256 indexed id, address indexed asset, address indexed recipient, uint256 amount);
    event PendingTransferFulfilled(uint256 indexed id, address indexed asset, address indexed recipient, uint256 amount);
    event Withdrawn(address indexed asset, uint256 amount, address indexed to);

    // ─── Errors ──────────────────────────────────────────────────

    error NotOwner();
    error NotAuthorizedBridge();
    error ERC20TransferFailed();
    error PendingTransferNotFound(uint256 id);
    error InsufficientBalance();

    // ─── Core ────────────────────────────────────────────────────

    function transfer(address recipient, address asset, uint256 amount) external;
    function fulfillPending(uint256 id) external;

    // ─── Views ───────────────────────────────────────────────────

    function owner() external view returns (address);
    function authorizedBridges(address bridge) external view returns (bool);
    function nextPendingId() external view returns (uint256);
    function pendingTransfers(uint256 id) external view returns (address asset, uint256 amount, address recipient);

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external;
    function setAuthorizedBridge(address bridge, bool enabled) external;
    function withdraw(address asset, uint256 amount, address to) external;
}