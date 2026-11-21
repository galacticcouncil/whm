// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface ISnowbridgeConverter {
    // ─── Events ──────────────────────────────────────────────────

    event Converted(address indexed source, address indexed target, address indexed sender, address to, uint256 amount);
    event PairSet(address indexed source, address indexed target);
    event Withdrawn(address indexed asset, uint256 amount, address indexed to);
    event PausedSet(bool paused);
    event OwnerSet(address indexed owner);
    event PauserSet(address indexed pauser);

    // ─── Errors ──────────────────────────────────────────────────

    error NotOwner();
    error NotPauser();
    error IsPaused();
    error ZeroAmount();
    error ZeroAddress();
    error PairNotSet(address source);
    error InvalidPair(address source, address target);
    error DecimalsMismatch(uint8 sourceDecimals, uint8 targetDecimals);
    error InsufficientInventory(address target, uint256 available);

    // ─── Core ────────────────────────────────────────────────────

    function convert(address source, uint256 amount) external;
    function convertTo(address source, uint256 amount, address to) external;

    // ─── Views ───────────────────────────────────────────────────

    function owner() external view returns (address);
    function pauser() external view returns (address);
    function paused() external view returns (bool);
    function targetOf(address source) external view returns (address);
    function isTarget(address asset) external view returns (bool);
    function available(address source) external view returns (uint256);

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external;
    function setPauser(address newPauser) external;
    function setPair(address source, address target) external;
    function setPaused(bool paused) external;
    function withdraw(address asset, uint256 amount, address to) external;
}
