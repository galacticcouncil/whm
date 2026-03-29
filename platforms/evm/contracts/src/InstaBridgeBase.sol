// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {ITokenBridge} from "wormhole-solidity-sdk/interfaces/ITokenBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {MessageReceiver} from "./MessageReceiver.sol";

/// @title InstaBridgeBase — Shared logic for InstaBridge variants
/// @notice Common storage, completeTransfer (VAA verification), and _processMessage.
///         Subclasses implement bridgeViaWormhole (outbound) and _executeTransfer (inbound).
abstract contract InstaBridgeBase is MessageReceiver {
    using SafeERC20 for IERC20;

    ITokenBridge public tokenBridge;
    uint32 public emitterNonce;

    /// @notice chainId → InstaTransfer address (bytes32 for cross-chain compat)
    mapping(uint16 => bytes32) public instaTransfers;

    event BridgeInitiated(
        address indexed asset,
        uint256 amount,
        uint256 fee,
        uint16 destChain,
        bytes32 recipient,
        uint64 transferSequence,
        uint64 messageSequence
    );

    event TransferProcessed(address indexed sourceAsset, uint256 amount, bytes32 indexed recipient);

    /// @notice Fixed fee per source asset (e.g. 1e6 for 1 USDC)
    mapping(address => uint256) public assetFee;

    error InstaTransferNotSet(uint16 chainId);
    error ZeroAmount();
    error AmountTooLowForFee(uint256 amount, uint256 fee);

    function _initInstaBridge(address _wormhole, address _tokenBridge)
        internal
        onlyInitializing
    {
        _initMessageReceiver(_wormhole);
        tokenBridge = ITokenBridge(_tokenBridge);
    }

    function _executeTransfer(address sourceAsset, uint256 amount, bytes32 recipient) internal virtual;

    function _processMessage(bytes memory payload) internal virtual override {
        (address sourceAsset, uint256 amount, bytes32 recipient) = abi.decode(payload, (address, uint256, bytes32));

        _executeTransfer(sourceAsset, amount, recipient);

        emit TransferProcessed(sourceAsset, amount, recipient);
    }

    function _fastTrack(
        address sourceAsset,
        uint256 amount,
        uint16 destChain,
        bytes32 recipient,
        uint64 transferSequence
    ) internal returns (uint64 messageSequence) {
        // Net amount after fee (fee stays in InstaTransfer on destination)
        uint256 fee = quoteFee(sourceAsset);
        if (amount <= fee) revert AmountTooLowForFee(amount, fee);
        uint256 netAmount = amount - fee;
        bytes memory payload = abi.encode(sourceAsset, netAmount, recipient);

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

    function setInstaTransfer(uint16 chainId, bytes32 addr) external onlyOwner {
        instaTransfers[chainId] = addr;
    }

    function setAssetFee(address asset, uint256 fee) external onlyOwner {
        assetFee[asset] = fee;
    }
}
