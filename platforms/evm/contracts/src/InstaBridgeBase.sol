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
        uint16 destChain,
        address destAsset,
        bytes32 recipient,
        uint64 transferSequence,
        uint64 messageSequence
    );

    event TransferProcessed(address indexed destAsset, uint256 amount, address indexed recipient);

    /// @notice Fee in basis points (1 bp = 0.01%, default 10 bp = 0.1%)
    uint256 public feeBps = 10;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    error InstaTransferNotSet(uint16 chainId);
    error ZeroAmount();

    function _initInstaBridge(address _wormhole, address _tokenBridge)
        internal
        onlyInitializing
    {
        _initMessageReceiver(_wormhole);
        tokenBridge = ITokenBridge(_tokenBridge);
    }

    function _executeTransfer(address destAsset, uint256 amount, address recipient) internal virtual;

    function _processMessage(bytes memory payload) internal virtual override {
        (address destAsset, uint256 amount, bytes32 recipientBytes) = abi.decode(payload, (address, uint256, bytes32));
        address recipient = address(uint160(uint256(recipientBytes)));

        _executeTransfer(destAsset, amount, recipient);

        emit TransferProcessed(destAsset, amount, recipient);
    }


    function completeTransfer(bytes memory vaa) external {
        receiveMessage(vaa);
    }

    function quoteFee(uint256 amount) public view returns (uint256 fee) {
        fee = (amount * feeBps) / BPS_DENOMINATOR;
    }

    // ─── Internal ────────────────────────────────────────────────

    function _bytes32ToAddress(bytes32 b) internal pure returns (address) {
        return address(uint160(uint256(b)));
    }

    // ─── Admin ───────────────────────────────────────────────────

    function setInstaTransfer(uint16 chainId, bytes32 addr) external onlyOwner {
        instaTransfers[chainId] = addr;
    }

    function setFeeBps(uint256 _feeBps) external onlyOwner {
        feeBps = _feeBps;
    }
}
