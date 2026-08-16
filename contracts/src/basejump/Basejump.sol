// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BasejumpCore} from "./BasejumpCore.sol";

import {IBasejump} from "./interfaces/IBasejump.sol";
import {IBasejumpLanding} from "./interfaces/IBasejumpLanding.sol";
import {INttManager} from "./interfaces/INttManager.sol";

/// @title Basejump — source EVM chains (Base, Ethereum) and the Hydration receiver
/// @notice Bridges funds INTO Hydration directly. Same source serves both roles:
///         - source deployment:  bridgeViaWormhole — NTT settlement + instant fast-path message
///         - Hydration receiver: completeTransfer — verifies the fast-path VAA, calls Landing

contract Basejump is BasejumpCore, IBasejump {
    using SafeERC20 for IERC20;

    /// @notice Landing on the current chain (fast-path delivery)
    bytes32 public landing;

    /// @notice Landing on the destination chain (NTT settlement recipient)
    bytes32 public landingDest;

    /// @notice Source asset → NTT manager that settles it
    mapping(address => address) public nttManagerFor;

    /// @notice Chain id of the settlement destination. Constant, not storage: `landingDest` is a
    ///         single slot, so one source deployment already serves exactly one destination —
    ///         a configurable chain id could never be changed independently of it.
    uint16 public constant HYDRATION_CHAIN_ID = 73;

    function initialize(address _wormhole, address _tokenBridge) public virtual initializer {
        _initBasejump(_wormhole, _tokenBridge);
    }

    function bridgeViaWormhole(
        address asset,
        uint256 amount,
        bytes32 recipient,
        bytes memory data
    ) external payable returns (uint64 transferSequence, uint64 messageSequence) {
        if (amount == 0) revert ZeroAmount();
        if (landingDest == bytes32(0)) revert BasejumpLandingNotSet(HYDRATION_CHAIN_ID);

        address manager = nttManagerFor[asset];
        if (manager == address(0)) revert SettlementRouteNotSet(asset);

        // Measure actual received amount (handles fee-on-transfer tokens)
        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        uint256 actualAmount = balanceAfter - balanceBefore;
        require(actualAmount > 0, "Zero amount received");

        // 1. Settlement: NTT moves the full amount to the Landing on the destination.
        (, uint256 deliveryPrice) = INttManager(manager).quoteDeliveryPrice(HYDRATION_CHAIN_ID, hex"00");

        IERC20(asset).forceApprove(manager, actualAmount);
        transferSequence =
            INttManager(manager).transfer{value: deliveryPrice}(actualAmount, HYDRATION_CHAIN_ID, landingDest);

        // 2. Fast path: instant-finality message with net amount (after fee)
        //    BasejumpLanding sends netAmount to recipient, keeps fee.
        //    `data` is opaque bytes forwarded end-to-end into the destination
        //    receiver's onBasejumpReceive callback (TokenBridge payload-3 style).
        messageSequence =
            _fastTrack(asset, actualAmount, HYDRATION_CHAIN_ID, recipient, transferSequence, data);
    }

    function _executeTransfer(uint16, address sourceAsset, uint256 amount, bytes32 recipient, bytes memory data)
        internal
        override
    {
        if (landing == bytes32(0)) revert BasejumpLandingNotSet(wormhole.chainId());

        IBasejumpLanding(_bytes32ToAddress(landing)).transfer(sourceAsset, amount, recipient, data);
    }

    // ─── Admin ──────────────────────────────────────────────────

    function setLanding(bytes32 _landing) external onlyOwner {
        landing = _landing;
    }

    function setLandingDest(bytes32 _landingDest) external onlyOwner {
        landingDest = _landingDest;
    }

    function setNttManager(address asset, address manager) external onlyOwner {
        nttManagerFor[asset] = manager;
    }

}
