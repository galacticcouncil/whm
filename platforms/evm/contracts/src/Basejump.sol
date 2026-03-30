// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BasejumpBase} from "./BasejumpBase.sol";
import {MrlPayload} from "./utils/MrlPayload.sol";

import {IBasejump} from "./interfaces/IBasejump.sol";
import {IBasejumpLanding} from "./interfaces/IBasejumpLanding.sol";

/// @title Basejump — Source EVM chain deployment (Base, Ethereum, etc.)
/// @notice Bridges funds INTO Hydration via Moonbeam GMP (MRL).
///         - bridgeViaWormhole: transferTokensWithPayload + MRL payload → Moonbeam GMP → XCM → Hydration
///         - completeTransfer: receives fast-path VAA, calls Landing directly on this chain
contract Basejump is BasejumpBase, IBasejump {
    using SafeERC20 for IERC20;

    /// @notice Moonbeam GMP precompile address (TokenBridge recipient for MRL routing)
    bytes32 public constant GMP_PRECOMPILE = bytes32(uint256(uint160(0x0000000000000000000000000000000000000816)));

    /// @notice Hydration parachain ID for MRL payload encoding
    uint32 public constant HYDRATION_PARA_ID = 2034;

    /// @notice Moonbeam wormhole id
    uint16 public constant MOONBEAM_WORMHOLE_ID = 16;

    /// @notice Landing on the current chain (for fast-path delivery)
    bytes32 public landing;

    /// @notice Landing on Hydration (MRL slow-path destination)
    bytes32 public landingDest;

    function initialize(
        address _wormhole,
        address _tokenBridge
    ) public virtual initializer {
        _initBasejump(_wormhole, _tokenBridge);
    }

    function bridgeViaWormhole(
        address asset,
        uint256 amount,
        bytes32 recipient
    ) external payable returns (uint64 transferSequence, uint64 messageSequence) {
        if (amount == 0) revert ZeroAmount();
        if (landingDest == bytes32(0)) revert BasejumpLandingNotSet(MOONBEAM_WORMHOLE_ID);

        // Measure actual received amount (handles fee-on-transfer tokens)
        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        uint256 actualAmount = balanceAfter - balanceBefore;
        require(actualAmount > 0, "Zero amount received");

        // 1. Slow path: TokenBridge transferWithPayload via MRL
        //    Full amount is bridged; fee stays in BasejumpLanding on destination
        //    recipient  = Moonbeam GMP precompile (routes via XCM to Hydration)
        //    payload    = MRL encoded destination (BasejumpLanding on Hydration)
        bytes memory mrlPayload = MrlPayload.encodeEth(HYDRATION_PARA_ID, _bytes32ToAddress(landingDest));

        IERC20(asset).forceApprove(address(tokenBridge), actualAmount);
        transferSequence = tokenBridge.transferTokensWithPayload(
            asset,
            actualAmount,
            MOONBEAM_WORMHOLE_ID,
            GMP_PRECOMPILE,
            emitterNonce,
            mrlPayload
        );

        // 2. Fast path: instant-finality message with net amount (after fee)
        //    BasejumpLanding sends netAmount to recipient, keeps fee
        messageSequence = _fastTrack(asset, actualAmount, MOONBEAM_WORMHOLE_ID, recipient, transferSequence);
    }

    function _executeTransfer(uint16, address sourceAsset, uint256 amount, bytes32 recipient) internal override {
        if (landing == bytes32(0)) revert BasejumpLandingNotSet(wormhole.chainId());

        IBasejumpLanding(_bytes32ToAddress(landing)).transfer(sourceAsset, amount, recipient);
    }

    // ─── Admin ──────────────────────────────────────────────────

    function setLanding(bytes32 _landing) external onlyOwner {
        landing = _landing;
    }

    function setLandingDest(bytes32 _landingDest) external onlyOwner {
        landingDest = _landingDest;
    }
}
