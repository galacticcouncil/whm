// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {ITokenBridge} from "wormhole-solidity-sdk/interfaces/ITokenBridge.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MessageReceiver} from "./MessageReceiver.sol";
import {IBasejumpBase} from "./interfaces/IBasejumpBase.sol";

/// @title BasejumpBase — Shared logic for Basejump variants
/// @notice Common storage, completeTransfer (VAA verification), and _processMessage.
///         Subclasses implement bridgeViaWormhole (outbound) and _executeTransfer (inbound).
abstract contract BasejumpBase is MessageReceiver, IBasejumpBase {
    using SafeERC20 for IERC20;

    ITokenBridge public tokenBridge;
    uint32 public emitterNonce;

    /// @notice Fixed fee per source asset (e.g. 1e6 for 1 USDC)
    mapping(address => uint256) public assetFee;

    function _initBasejump(address _wormhole, address _tokenBridge) internal onlyInitializing {
        _initMessageReceiver(_wormhole);
        tokenBridge = ITokenBridge(_tokenBridge);
    }

    function _executeTransfer(uint16 sourceChain, address sourceAsset, uint256 amount, bytes32 recipient)
        internal
        virtual;

    function _processMessage(IWormhole.VM memory vm) internal virtual override {
        IBasejumpBase.TransferPayload memory transfer = abi.decode(vm.payload, (IBasejumpBase.TransferPayload));

        _executeTransfer(vm.emitterChainId, transfer.sourceAsset, transfer.amount, transfer.recipient);

        emit TransferProcessed(transfer.sourceAsset, transfer.amount, transfer.recipient);
    }

    function _fastTrack(
        address sourceAsset,
        uint256 amount,
        uint16 destChain,
        bytes32 recipient,
        uint64 transferSequence
    ) internal returns (uint64 messageSequence) {
        // Net amount after fee (fee stays in BasejumpLanding on destination)
        uint256 fee = quoteFee(sourceAsset);
        if (amount <= fee) revert AmountTooLowForFee(amount, fee);
        uint256 netAmount = amount - fee;

        IBasejumpBase.TransferPayload memory transfer = IBasejumpBase.TransferPayload({
            sourceAsset: sourceAsset, amount: netAmount, recipient: recipient, transferSequence: transferSequence
        });

        bytes memory payload = abi.encode(transfer);

        uint256 messageFee = wormhole.messageFee();
        messageSequence = wormhole.publishMessage{value: messageFee}(emitterNonce, payload, 200);

        emitterNonce++;

        emit BridgeInitiated(sourceAsset, amount, fee, destChain, recipient, transferSequence, messageSequence);
    }

    function completeTransfer(bytes memory vaa) external {
        receiveMessage(vaa);
    }

    function quoteFee(address asset) public view returns (uint256 fee) {
        fee = assetFee[asset];
    }

    // ─── Internal ────────────────────────────────────────────────

    function _bytes32ToAddress(bytes32 b) internal pure returns (address) {
        return address(uint160(uint256(b)));
    }

    // ─── Admin ───────────────────────────────────────────────────

    function setAssetFee(address asset, uint256 fee) external onlyOwner {
        assetFee[asset] = fee;
    }
}
