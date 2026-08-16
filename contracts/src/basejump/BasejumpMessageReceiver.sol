// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {BasejumpCore} from "./BasejumpCore.sol";

import {IBasejumpLanding} from "./interfaces/IBasejumpLanding.sol";

/// @title BasejumpMessageReceiver — Hydration end of the direct corridor
/// @notice Verifies the fast-path VAA published by a source Basejump and delivers it through
///         BasejumpLanding on the same chain. Successor to BasejumpProxy: same role, minus the
///         Moonbeam hop — no XcmTransactor, no XCM, and no outbound path to leave inert.
/// @dev Initialized through the inherited MessageReceiver.initialize(wormhole). `tokenBridge`
///      is deliberately never set — the receiver only receives.
///      BasejumpProxy.resetProcessedVaa has no counterpart here: it existed because XCM could
///      fail on Hydration after the VAA was already marked processed. With no hop, a landing
///      revert rolls back receiveMessage in the same transaction and the relayer simply retries.
contract BasejumpMessageReceiver is BasejumpCore {
    /// @notice Landing pool on this chain
    bytes32 public landing;

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
}
