// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {InstaBridgeBase} from "./InstaBridgeBase.sol";
import {MrlPayload} from "./utils/MrlPayload.sol";

import {IInstaTransfer} from "./interfaces/IInstaTransfer.sol";

/// @title InstaBridge — Source EVM chain deployment (Base, Ethereum, etc.)
/// @notice Bridges funds INTO Hydration via Moonbeam GMP (MRL).
///         - bridgeViaWormhole: transferTokensWithPayload + MRL payload → Moonbeam GMP → XCM → Hydration
///         - completeTransfer: receives fast-path VAA, calls InstaTransfer directly on this chain
contract InstaBridge is InstaBridgeBase {
    using SafeERC20 for IERC20;

    /// @notice Moonbeam GMP precompile address (TokenBridge recipient for MRL routing)
    bytes32 public constant GMP_PRECOMPILE = bytes32(uint256(uint160(0x0000000000000000000000000000000000000816)));

    /// @notice Hydration parachain ID for MRL payload encoding
    uint32 public constant HYDRATION_PARA_ID = 2034;

    function initialize(
        address _wormhole,
        address _tokenBridge
    ) public virtual initializer {
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

        // 1. Slow path: TokenBridge transferWithPayload via MRL
        //    destChain  = Moonbeam wormhole chain ID (e.g. 16)
        //    recipient  = Moonbeam GMP precompile (routes via XCM to Hydration)
        //    payload    = MRL encoded destination (InstaTransfer on Hydration)
        address instaTransfer = _bytes32ToAddress(destInstaTransfer);
        bytes memory mrlPayload = MrlPayload.encodeEth(HYDRATION_PARA_ID, instaTransfer);

        IERC20(asset).forceApprove(address(tokenBridge), amount);
        transferSequence = tokenBridge.transferTokensWithPayload(
            asset,
            amount,
            destChain,
            GMP_PRECOMPILE,
            emitterNonce,
            mrlPayload
        );

        // 2. Fast path: instant-finality message with transfer metadata (amount after fee)
        messageSequence = _fastTrack(asset, amount, destChain, destAsset, recipient, transferSequence);
    }

    function _executeTransfer(address sourceAsset, address destAsset, uint256 amount, bytes32 recipient) internal override {
        uint16 localChain = wormhole.chainId();
        bytes32 localInstaTransfer = instaTransfers[localChain];
        if (localInstaTransfer == bytes32(0)) revert InstaTransferNotSet(localChain);

        address instaTransfer = _bytes32ToAddress(localInstaTransfer);
        IInstaTransfer(instaTransfer).transfer(sourceAsset, destAsset, amount, recipient);
    }

}
