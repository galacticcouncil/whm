// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {BasejumpCore} from "./BasejumpCore.sol";

import {IBasejumpLanding} from "./interfaces/IBasejumpLanding.sol";

/// @title BasejumpMessageReceiver — Hydration end of the direct corridor
/// @notice Verifies the fast-path VAA published by a source Basejump and delivers it through
///         BasejumpLanding on the same chain
/// @dev Initialized through the inherited MessageReceiver.initialize(wormhole). `tokenBridge` is
///      never set — the receiver only receives. Delivery is same-chain, so a landing revert
///      unwinds receiveMessage and processedVaas is never written; no replay power is needed.
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
