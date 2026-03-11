// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

/// @title InstaTransfer - Instant token delivery for cross-chain bridges
/// @notice Pre-funded liquidity pool. Authorized bridges call transfer() to
///         deliver tokens instantly. Slow bridge tokens replenish the pool.
///         Fees are deducted on the InstaBridge side. Replay protection is
///         handled by the bridge layer (MessageReceiver.processedVaas).
contract InstaTransfer is Initializable, UUPSUpgradeable {
    address public owner;
    mapping(address => bool) public authorizedBridges;

    struct PendingTransfer {
        address asset;
        uint256 amount;
        address recipient;
    }

    uint256 public nextPendingId;
    mapping(uint256 => PendingTransfer) public pendingTransfers;

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

    // ─── Modifiers ───────────────────────────────────────────────

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    modifier onlyAuthorizedBridge() {
        _onlyAuthorizedBridge();
        _;
    }

    function _onlyOwner() internal view {
        if (msg.sender != owner) revert NotOwner();
    }

    function _onlyAuthorizedBridge() internal view {
        if (!authorizedBridges[msg.sender]) revert NotAuthorizedBridge();
    }

    // ─── Init ────────────────────────────────────────────────────

    constructor() {
        _disableInitializers();
    }

    function initialize() public initializer {
        owner = msg.sender;
    }

    // ─── Core ────────────────────────────────────────────────────

    /// @notice Deliver tokens to recipient. If insufficient balance, queue as pending.
    function transfer(address asset, uint256 amount, address recipient) external onlyAuthorizedBridge {
        if (IERC20(asset).balanceOf(address(this)) >= amount) {
            if (!IERC20(asset).transfer(recipient, amount)) revert ERC20TransferFailed();
            emit TransferExecuted(asset, recipient, amount);
        } else {
            uint256 id = nextPendingId++;
            pendingTransfers[id] = PendingTransfer({asset: asset, amount: amount, recipient: recipient});
            emit TransferQueued(id, asset, recipient, amount);
        }
    }

    /// @notice Fulfill a pending transfer once liquidity is available.
    function fulfillPending(uint256 id) external {
        PendingTransfer memory pt = pendingTransfers[id];
        if (pt.recipient == address(0)) revert PendingTransferNotFound(id);
        if (IERC20(pt.asset).balanceOf(address(this)) < pt.amount) revert InsufficientBalance();

        delete pendingTransfers[id];

        if (!IERC20(pt.asset).transfer(pt.recipient, pt.amount)) revert ERC20TransferFailed();
        emit PendingTransferFulfilled(id, pt.asset, pt.recipient, pt.amount);
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != owner) revert NotOwner();
    }

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    function setAuthorizedBridge(address bridge, bool enabled) external onlyOwner {
        authorizedBridges[bridge] = enabled;
    }

    /// @notice Emergency withdrawal of tokens
    function withdraw(address asset, uint256 amount, address to) external onlyOwner {
        if (!IERC20(asset).transfer(to, amount)) revert ERC20TransferFailed();
        emit Withdrawn(asset, amount, to);
    }
}