// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface IInstaTransfer {
    // ─── Events ──────────────────────────────────────────────────

    event TransferExecuted(address indexed asset, address indexed recipient, uint256 amount);
    event Withdrawn(address indexed asset, uint256 amount, address indexed to);

    // ─── Errors ──────────────────────────────────────────────────

    error NotOwner();
    error NotAuthorizedBridge();
    error ERC20TransferFailed();

    // ─── Core ────────────────────────────────────────────────────

    function transfer(address asset, uint256 amount, address recipient) external;

    // ─── Views ───────────────────────────────────────────────────

    function owner() external view returns (address);
    function authorizedBridges(address bridge) external view returns (bool);

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external;
    function setAuthorizedBridge(address bridge, bool enabled) external;
    function withdraw(address asset, uint256 amount, address to) external;
}