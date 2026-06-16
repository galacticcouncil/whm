// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IIntentRouter} from "./interfaces/IIntentRouter.sol";

/// @title IntentRouter — Ethereum adapter between Basejump and NEAR Intents (Defuse / OneClick)
/// @notice Receives tokens delivered by an authorized BasejumpLanding via the onBasejumpReceive
///         callback, decodes (intentId, depositAddress) from the Basejump payload, and forwards
///         the same amount of the same asset to the quote-specific origin-chain depositAddress
///         in the same call. Asset-agnostic — whatever the authorized landing delivers is
///         forwarded as-is; no on-chain asset whitelist. Holds no liquidity in the happy path;
///         sweep() exists for operator recovery of stuck or stray tokens.
contract IntentRouter is Initializable, UUPSUpgradeable, IIntentRouter {
    using SafeERC20 for IERC20;

    /// @notice Sentinel `asset` value for native ETH.
    address public constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    address public owner;
    address public basejumpLanding;

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    function _onlyOwner() internal view {
        if (msg.sender != owner) revert NotOwner();
    }

    constructor() {
        _disableInitializers();
    }

    function initialize(address _basejumpLanding) public initializer {
        owner = msg.sender;
        basejumpLanding = _basejumpLanding;
    }

    /// @notice Accept native ETH.
    receive() external payable {}

    // ─── IBasejumpReceiver ───────────────────────────────────────

    function onBasejumpReceive(address asset, uint256 amount, bytes calldata data) external {
        if (msg.sender != basejumpLanding) revert NotBasejumpLanding(msg.sender);
        if (data.length != 64) revert MalformedData();

        (bytes32 intentId, address depositAddress) = abi.decode(data, (bytes32, address));
        if (depositAddress == address(0)) revert InvalidDepositAddress();

        _forward(asset, depositAddress, amount);

        emit IntentForwarded(intentId, asset, depositAddress, amount);
    }

    // ─── Helpers ─────────────────────────────────────────────────

    function _forward(address asset, address to, uint256 amount) internal {
        if (asset == NATIVE) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override onlyOwner {}

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    function setBasejumpLanding(address _basejumpLanding) external onlyOwner {
        emit BasejumpLandingUpdated(basejumpLanding, _basejumpLanding);
        basejumpLanding = _basejumpLanding;
    }

    /// @notice Emergency withdrawal of assets.
    function sweep(address asset, address to, uint256 amount) external onlyOwner {
        _forward(asset, to, amount);
        emit Swept(asset, to, amount);
    }
}
