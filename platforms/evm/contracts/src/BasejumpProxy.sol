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

    event VaaResetForRecovery(bytes32 indexed vaaHash);

    error XcmTransactorNotSet();
    error NotSupported();

    function initialize(address _wormhole, address _tokenBridge) public virtual initializer {
        _initBasejump(_wormhole, _tokenBridge);
    }

    function bridgeViaWormhole(
        address asset,
        uint256 amount,
        uint16 destChain,
        bytes32 recipient
    ) external payable override returns (uint64 transferSequence, uint64 messageSequence) {
        if (amount == 0) revert ZeroAmount();

        bytes32 destBasejumpLanding = basejumpLandings[destChain];
        if (destBasejumpLanding == bytes32(0)) revert BasejumpLandingNotSet(destChain);

        // Measure actual received amount (handles fee-on-transfer tokens)
        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        uint256 actualAmount = balanceAfter - balanceBefore;
        require(actualAmount > 0, "Zero amount received");

        // 1. Slow path: TokenBridge transferWithPayload via MRL
        //    Full amount is bridged; fee stays in BasejumpLanding on destination
        IERC20(asset).forceApprove(address(tokenBridge), actualAmount);
        transferSequence = tokenBridge.transferTokens(
            asset,
            actualAmount,
            destChain,
            destBasejumpLanding,
            0,
            emitterNonce
        );

        // 2. Fast path: instant-finality message with net amount (after fee)
        //    BasejumpLanding sends netAmount to recipient, keeps fee
        messageSequence = _fastTrack(asset, actualAmount, destChain, recipient, transferSequence);
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

    // ─── Recovery ───────────────────────────────────────────────

    /// @notice Reset a processed VAA flag to allow replay
    /// @dev EMERGENCY USE ONLY: Use when XCM execution failed on Hydration after VAA was marked processed
    /// @param vaaHash The hash of the VAA to reset (from wormhole.parseAndVerifyVM(vaa).hash)
    function resetProcessedVaa(bytes32 vaaHash) external onlyOwner {
        require(processedVaas[vaaHash], "VAA not processed");
        processedVaas[vaaHash] = false;
        emit VaaResetForRecovery(vaaHash);
    }

    // ─── Admin ──────────────────────────────────────────────────

    function setXcmTransactor(address _xcmTransactor) external onlyOwner {
        xcmTransactor = _xcmTransactor;
    }
}
