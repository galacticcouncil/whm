// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISnowbridgeConverter} from "./interfaces/ISnowbridgeConverter.sol";

/// @title SnowbridgeConverter - one-way 1:1 conversion of Snowbridge assets into their NTT twins on Hydration
/// @notice Pays the NTT asset out of inventory minted by governance at the switch, against the frozen
///         Snowbridge backing. Collected Snowbridge assets stay here until governance burns them.
contract SnowbridgeConverter is Initializable, UUPSUpgradeable, ISnowbridgeConverter {
    using SafeERC20 for IERC20;

    address public owner;
    address public pauser;
    bool public paused;

    mapping(address => address) public targetOf;
    mapping(address => uint256) public targetRefs;

    // ─── Modifiers ───────────────────────────────────────────────

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    function _onlyOwner() internal view {
        if (msg.sender != owner) revert NotOwner();
    }

    // ─── Init ────────────────────────────────────────────────────

    constructor() {
        _disableInitializers();
    }

    function initialize() public initializer {
        owner = msg.sender;
        emit OwnerSet(msg.sender);
    }

    // ─── Core ────────────────────────────────────────────────────

    function convert(address source, uint256 amount) external {
        _convert(source, amount, msg.sender);
    }

    function convertTo(address source, uint256 amount, address to) external {
        if (to == address(0)) revert ZeroAddress();
        _convert(source, amount, to);
    }

    function _convert(address source, uint256 amount, address to) internal {
        if (paused) revert IsPaused();
        if (amount == 0) revert ZeroAmount();

        address target = targetOf[source];
        if (target == address(0)) revert PairNotSet(source);

        uint256 inventory = IERC20(target).balanceOf(address(this));
        if (inventory < amount) revert InsufficientInventory(target, inventory);

        IERC20(source).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(target).safeTransfer(to, amount);

        emit Converted(source, target, msg.sender, to, amount);
    }

    // ─── Views ───────────────────────────────────────────────────

    function isTarget(address asset) public view returns (bool) {
        return targetRefs[asset] > 0;
    }

    function available(address source) external view returns (uint256) {
        address target = targetOf[source];
        if (target == address(0)) return 0;
        return IERC20(target).balanceOf(address(this));
    }

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
        emit OwnerSet(newOwner);
    }

    function setPauser(address newPauser) external onlyOwner {
        pauser = newPauser;
        emit PauserSet(newPauser);
    }

    function setPair(address source, address target) external onlyOwner {
        if (source == address(0)) revert ZeroAddress();

        if (target != address(0)) {
            if (source == target || isTarget(source) || targetOf[target] != address(0)) {
                revert InvalidPair(source, target);
            }
            uint8 sourceDecimals = IERC20Metadata(source).decimals();
            uint8 targetDecimals = IERC20Metadata(target).decimals();
            if (sourceDecimals != targetDecimals) revert DecimalsMismatch(sourceDecimals, targetDecimals);
            targetRefs[target]++;
        }

        address previous = targetOf[source];
        if (previous != address(0)) targetRefs[previous]--;

        targetOf[source] = target;
        emit PairSet(source, target);
    }

    function setPaused(bool paused_) external {
        if (paused_) {
            if (msg.sender != owner && msg.sender != pauser) revert NotPauser();
        } else {
            _onlyOwner();
        }
        paused = paused_;
        emit PausedSet(paused_);
    }

    function withdraw(address asset, uint256 amount, address to) external onlyOwner {
        IERC20(asset).safeTransfer(to, amount);
        emit Withdrawn(asset, amount, to);
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override {
        _onlyOwner();
    }
}
