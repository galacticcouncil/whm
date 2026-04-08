// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {BasejumpBase} from "./BasejumpBase.sol";
import {XcmTransactor} from "./XcmTransactor.sol";

import {IBasejumpProxy} from "./interfaces/IBasejumpProxy.sol";
import {IBasejumpLanding} from "./interfaces/IBasejumpLanding.sol";

/// @title BasejumpProxy — Moonchain deployment (Hydration proxy)
/// @notice Bridges funds OUT from Hydration to external wormhole chains.
///         - bridgeViaWormhole: called via XCM from Hydration, sends tokens out
///         - completeTransfer: receives fast-path VAA, forwards to Hydration Landing via XCM
contract BasejumpProxy is BasejumpBase, IBasejumpProxy {
    using SafeERC20 for IERC20;

    address public xcmTransactor;

    /// @notice chainId (from) → Landing on Hydration (inbound fast-path delivery)
    mapping(uint16 => bytes32) public landings;

    /// @notice chainId (to) → Landing on destination chains (outbound slow-path recipient)
    mapping(uint16 => bytes32) public landingsDest;

    error XcmTransactorNotSet();
    error NotSupported();

    event VaaResetForRecovery(bytes32 indexed vaaHash);

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

        bytes32 destLanding = landingsDest[destChain];
        if (destLanding == bytes32(0)) revert BasejumpLandingNotSet(destChain);

        // Measure actual received amount (handles fee-on-transfer tokens)
        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        uint256 actualAmount = balanceAfter - balanceBefore;
        require(actualAmount > 0, "Zero amount received");

        // 1. Slow path: TokenBridge transferTokens
        //    Full amount is bridged; fee stays in BasejumpLanding on destination
        IERC20(asset).forceApprove(address(tokenBridge), actualAmount);
        transferSequence = tokenBridge.transferTokens(
            asset,
            actualAmount,
            destChain,
            destLanding,
            0,
            emitterNonce
        );

        // 2. Fast path: instant-finality message with net amount (after fee)
        //    BasejumpLanding sends netAmount to recipient, keeps fee
        messageSequence = _fastTrack(asset, actualAmount, destChain, recipient, transferSequence);
    }

    function _executeTransfer(uint16 sourceChain, address sourceAsset, uint256 amount, bytes32 recipient) internal override {
        if (xcmTransactor == address(0)) revert XcmTransactorNotSet();

        bytes32 sourceLanding = landings[sourceChain];
        if (sourceLanding == bytes32(0)) revert BasejumpLandingNotSet(sourceChain);

        address basejumpLanding = _bytes32ToAddress(sourceLanding);

        bytes memory input = abi.encodeWithSelector(IBasejumpLanding.transfer.selector, sourceAsset, amount, recipient);

        XcmTransactor(xcmTransactor).transact(basejumpLanding, input);
    }

    // ─── Recovery ───────────────────────────────────────────────

    /// @notice Reset a processed VAA flag to allow replay
    /// @dev VULNERABLE: After reset, anyone can call completeTransfer(vaa) to replay.
    ///      Use fix_resetProcessedVaa instead for atomic recovery.
    /// @param vaaHash The hash of the VAA to reset (from wormhole.parseAndVerifyVM(vaa).hash)
    function resetProcessedVaa(bytes32 vaaHash) external onlyOwner {
        require(processedVaas[vaaHash], "VAA not processed");
        processedVaas[vaaHash] = false;
        emit VaaResetForRecovery(vaaHash);
    }

    /// @notice Atomic VAA recovery: resets the processed flag and immediately
    ///         re-processes the VAA in the same transaction, preventing front-running.
    /// @dev Replaces resetProcessedVaa for safe recovery. The full VAA bytes are
    ///      required (not just the hash) so the message can be re-verified and re-executed.
    /// @param vaa The raw VAA bytes to recover
    function fix_resetProcessedVaa(bytes memory vaa) external onlyOwner {
        (IWormhole.VM memory vm, bool valid, string memory reason) = wormhole.parseAndVerifyVM(vaa);
        require(valid, reason);
        require(processedVaas[vm.hash], "VAA not processed");

        processedVaas[vm.hash] = false;
        this.receiveMessage(vaa);

        emit VaaResetForRecovery(vm.hash);
    }

    // ─── Admin ──────────────────────────────────────────────────

    function setXcmTransactor(address _xcmTransactor) external onlyOwner {
        xcmTransactor = _xcmTransactor;
    }

    function setLanding(uint16 chainId, bytes32 addr) external onlyOwner {
        landings[chainId] = addr;
    }

    function setLandingDest(uint16 chainId, bytes32 addr) external onlyOwner {
        landingsDest[chainId] = addr;
    }
}
