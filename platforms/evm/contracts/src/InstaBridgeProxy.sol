// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {InstaBridgeBase} from "./InstaBridgeBase.sol";
import {XcmTransactor} from "./XcmTransactor.sol";

import {IInstaTransfer} from "./interfaces/IInstaTransfer.sol";

/// @title InstaBridgeProxy — Moonchain deployment (Hydration proxy)
/// @notice Bridges funds OUT from Hydration to external wormhole chains.
///         - bridgeViaWormhole: called via XCM from Hydration, sends tokens out
///         - completeTransfer: receives fast-path VAA, forwards to Hydration InstaTransfer via XCM
contract InstaBridgeProxy is InstaBridgeBase {
    using SafeERC20 for IERC20;

    address public xcmTransactor;

    error XcmTransactorNotSet();

    function initialize(address _wormhole, address _tokenBridge) public virtual initializer {
        _initInstaBridge(_wormhole, _tokenBridge);
    }

    function bridgeViaWormhole(
        address asset,
        uint256 amount,
        uint16 destChain,
        address destAsset,
        bytes32 recipient
    ) external payable returns (uint64 transferSequence, uint64 messageSequence) {
        if (amount == 0) revert ZeroAmount();

        bytes32 destInstaTransfer = instaTransfers[destChain];
        if (destInstaTransfer == bytes32(0)) revert InstaTransferNotSet(destChain);

        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);

        // 1. Slow path: TokenBridge transfer (recipient = InstaTransfer on dest chain)
        IERC20(asset).forceApprove(address(tokenBridge), amount);
        transferSequence = tokenBridge.transferTokens(
            asset,
            amount,
            destChain,
            destInstaTransfer,
            0,
            emitterNonce
        );

        // 2. Fast path: instant-finality message with transfer metadata (amount after fee)
        messageSequence = _fastTrack(asset, amount, destChain, destAsset, recipient, transferSequence);
    }

    function _executeTransfer(address sourceAsset, address destAsset, uint256 amount, bytes32 recipient) internal override {
        if (xcmTransactor == address(0)) revert XcmTransactorNotSet();

        uint16 localChain = wormhole.chainId();
        bytes32 localInstaTransfer = instaTransfers[localChain];
        if (localInstaTransfer == bytes32(0)) revert InstaTransferNotSet(localChain);

        address instaTransfer = _bytes32ToAddress(localInstaTransfer);

        bytes memory input = abi.encodeWithSelector(IInstaTransfer.transfer.selector, sourceAsset, destAsset, amount, recipient);
        XcmTransactor(xcmTransactor).transact(instaTransfer, input);
    }

    // ─── Admin ──────────────────────────────────────────────────

    function setXcmTransactor(address _xcmTransactor) external onlyOwner {
        xcmTransactor = _xcmTransactor;
    }
}
