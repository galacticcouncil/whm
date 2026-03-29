// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BasejumpBase} from "./BasejumpBase.sol";
import {XcmTransactor} from "./XcmTransactor.sol";

import {IBasejumpLanding} from "./interfaces/IBasejumpLanding.sol";

/// @title BasejumpProxy — Moonchain deployment (Hydration proxy)
/// @notice Bridges funds OUT from Hydration to external wormhole chains.
///         - bridgeViaWormhole: called via XCM from Hydration, sends tokens out
///         - completeTransfer: receives fast-path VAA, forwards to Hydration BasejumpLanding via XCM
contract BasejumpProxy is BasejumpBase {
    using SafeERC20 for IERC20;

    address public xcmTransactor;

    error XcmTransactorNotSet();

    function initialize(address _wormhole, address _tokenBridge) public virtual initializer {
        _initBasejump(_wormhole, _tokenBridge);
    }

    function bridgeViaWormhole(
        address asset,
        uint256 amount,
        uint16 destChain,
        bytes32 recipient
    ) external payable returns (uint64 transferSequence, uint64 messageSequence) {
        if (amount == 0) revert ZeroAmount();

        bytes32 destBasejumpLanding = basejumpLandings[destChain];
        if (destBasejumpLanding == bytes32(0)) revert BasejumpLandingNotSet(destChain);

        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);

        // 1. Slow path: TokenBridge transfer (recipient = BasejumpLanding on dest chain)
        IERC20(asset).forceApprove(address(tokenBridge), amount);
        transferSequence = tokenBridge.transferTokens(
            asset,
            amount,
            destChain,
            destBasejumpLanding,
            0,
            emitterNonce
        );

        // 2. Fast path: instant-finality message with transfer metadata (amount after fee)
        messageSequence = _fastTrack(asset, amount, destChain, recipient, transferSequence);
    }

    function _executeTransfer(address sourceAsset, uint256 amount, bytes32 recipient) internal override {
        if (xcmTransactor == address(0)) revert XcmTransactorNotSet();

        uint16 localChain = wormhole.chainId();
        bytes32 localBasejumpLanding = basejumpLandings[localChain];
        if (localBasejumpLanding == bytes32(0)) revert BasejumpLandingNotSet(localChain);

        address basejumpLanding = _bytes32ToAddress(localBasejumpLanding);

        bytes memory input = abi.encodeWithSelector(IBasejumpLanding.transfer.selector, sourceAsset, amount, recipient);
        XcmTransactor(xcmTransactor).transact(basejumpLanding, input);
    }

    // ─── Admin ──────────────────────────────────────────────────

    function setXcmTransactor(address _xcmTransactor) external onlyOwner {
        xcmTransactor = _xcmTransactor;
    }
}
