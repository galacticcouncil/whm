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
    error NotSupported();

    function initialize(address _wormhole, address _tokenBridge) public virtual initializer {
        _initBasejump(_wormhole, _tokenBridge);
    }

    function bridgeViaWormhole(
        address,
        uint256,
        uint16,
        bytes32
    ) external payable override returns (uint64, uint64) {
        revert NotSupported();
    }

    function _executeTransfer(address sourceAsset, uint256 amount, bytes32 recipient) internal override {
        if (xcmTransactor == address(0)) revert XcmTransactorNotSet();

        uint16 localChain = wormhole.chainId();
        bytes32 localBasejumpLanding = basejumpLandings[localChain];
        if (localBasejumpLanding == bytes32(0)) revert BasejumpLandingNotSet(localChain);

        address basejumpLanding = _bytes32ToAddress(localBasejumpLanding);

        bytes memory input = abi.encodeWithSelector(IBasejumpLanding.transfer.selector, sourceAsset, amount, recipient);

        // SECURITY NOTE: If XCM execution fails on Hydration (congestion, gas limits, etc.),
        // the VAA has already been marked as processed in receiveMessage() (line 52 MessageReceiver.sol).
        // This creates a permanent fund loss scenario with no recovery mechanism.
        // TODO: Implement recovery system - options:
        //   1. Event-based retry mechanism with off-chain relayer
        //   2. Failed transfer storage with manual admin recovery
        //   3. XCM execution status verification before marking VAA as processed
        XcmTransactor(xcmTransactor).transact(basejumpLanding, input);
    }

    // ─── Admin ──────────────────────────────────────────────────

    function setXcmTransactor(address _xcmTransactor) external onlyOwner {
        xcmTransactor = _xcmTransactor;
    }
}
