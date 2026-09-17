// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {MessageReceiver} from "../MessageReceiver.sol";

import {IBasejumpLanding} from "./interfaces/IBasejumpLanding.sol";
import {IBasejumpPayload} from "./interfaces/IBasejumpPayload.sol";
import {IBasejumpReceiver} from "./interfaces/IBasejumpReceiver.sol";

/// @title BasejumpReceiver — Hydration end of the direct corridor
/// @notice Verifies the fast-path VAA published by a source BasejumpEmitter and delivers it through
///         the landing pool on this chain.
/// @dev Initialized through the inherited `MessageReceiver.initialize(wormhole)`. Delivery is
///      same-chain, so a landing revert unwinds `receiveMessage` and `processedVaas` is never
///      written — the VAA stays redeemable and no owner power to replay one is needed.
contract BasejumpReceiver is MessageReceiver, IBasejumpReceiver, IBasejumpPayload {
    /// @notice Landing pool on this chain.
    bytes32 public landing;

    /// @inheritdoc IBasejumpReceiver
    function completeTransfer(bytes memory vaa) external {
        receiveMessage(vaa);
    }

    // ─── Internal ────────────────────────────────────────────────

    function _processMessage(IWormhole.VM memory vm) internal override {
        if (landing == bytes32(0)) revert LandingNotSet();

        TransferPayload memory transfer = abi.decode(vm.payload, (TransferPayload));

        IBasejumpLanding(address(uint160(uint256(landing)))).transfer(
            transfer.sourceAsset, transfer.amount, transfer.recipient, transfer.data
        );

        emit TransferProcessed(transfer.sourceAsset, transfer.amount, transfer.recipient);
    }

    // ─── Admin ───────────────────────────────────────────────────

    function setLanding(bytes32 _landing) external onlyOwner {
        landing = _landing;
    }
}
