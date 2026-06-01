// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IBasejumpLandingEvm} from "./interfaces/IBasejumpLandingEvm.sol";
import {IBasejumpReceiver} from "./interfaces/IBasejumpReceiver.sol";

/// @title BasejumpLandingEvm — Instant token delivery for cross-chain bridges on EVM chains
/// @notice Pre-funded ERC20 pool. Authorized bridges call transfer() to deliver `asset`
///         to `recipient`. `asset` is the destination-chain ERC20 address — no source↔dest
///         mapping is maintained here because on EVM the address in the payload IS the
///         address the bridge wants paid out. (The Hydration landing keeps a mapping only
///         because substrate currency_id ≠ ERC20 address.)
///
///         If the pool is short on liquidity at delivery time, the transfer is queued
///         and can be fulfilled by anyone later via `fulfillPending` once the slow
///         TokenBridge path replenishes the pool (~13 min).
///
///         When the Basejump payload carries non-empty `data`, the recipient is treated
///         as a contract implementing IBasejumpReceiver and `onBasejumpReceive` is
///         invoked atomically with delivery — either immediately (sufficient liquidity)
///         or at the moment `fulfillPending` drains the queued entry. Quote-side TTL +
///         OneClick's refund-to-`refundTo` mechanism handles the case where the queue
///         drains after the receiver's intent expires.
contract BasejumpLandingEvm is Initializable, UUPSUpgradeable, IBasejumpLandingEvm {
    using SafeERC20 for IERC20;

    address public owner;
    mapping(address => bool) public authorizedBridges;

    struct PendingTransfer {
        address asset;
        uint256 amount;
        bytes32 recipient;
        bytes data;
    }

    uint256 public pendingHead;
    uint256 public pendingTail;
    mapping(uint256 => PendingTransfer) public pendingTransfers;

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

    function transfer(address asset, uint256 amount, bytes32 recipient, bytes memory data)
        external
        onlyAuthorizedBridge
    {
        address recipientAddr = address(uint160(uint256(recipient)));

        // Validate receiver shape upfront — applies whether we deliver now or queue.
        // (Code presence can only grow over time post-Cancun, so a contract recipient at
        // queue time is still a contract at drain time.)
        if (data.length > 0 && recipientAddr.code.length == 0) {
            revert ReceiverNotContract(recipientAddr);
        }

        if (IERC20(asset).balanceOf(address(this)) >= amount) {
            _deliver(asset, amount, recipientAddr, data);
        } else {
            uint256 id = pendingTail++;
            pendingTransfers[id] =
                PendingTransfer({asset: asset, amount: amount, recipient: recipient, data: data});
            emit TransferQueued(id, asset, recipientAddr, amount);
        }
    }

    function fulfillPending() external {
        if (pendingHead >= pendingTail) revert NoPendingTransfers();

        uint256 id = pendingHead;
        PendingTransfer memory pt = pendingTransfers[id];
        if (IERC20(pt.asset).balanceOf(address(this)) < pt.amount) revert InsufficientBalance();

        pendingHead++;
        delete pendingTransfers[id];

        address recipientAddr = address(uint160(uint256(pt.recipient)));
        _deliver(pt.asset, pt.amount, recipientAddr, pt.data);
        emit PendingTransferFulfilled(id, pt.asset, recipientAddr, pt.amount);
    }

    function _deliver(address asset, uint256 amount, address recipientAddr, bytes memory data) internal {
        IERC20(asset).safeTransfer(recipientAddr, amount);
        emit TransferExecuted(asset, recipientAddr, amount);

        if (data.length > 0) {
            IBasejumpReceiver(recipientAddr).onBasejumpReceive(asset, amount, data);
        }
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override {
        _onlyOwner();
    }

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    function setAuthorizedBridge(address bridge, bool enabled) external onlyOwner {
        authorizedBridges[bridge] = enabled;
    }

    /// @notice Emergency withdrawal of ERC20 tokens
    function withdraw(address asset, uint256 amount, address to) external onlyOwner {
        IERC20(asset).safeTransfer(to, amount);
        emit Withdrawn(asset, amount, to);
    }
}
