// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {INttManager} from "../ntt/interfaces/INttManager.sol";

import {HydrationConsts} from "../utils/hydration/HydrationConsts.sol";
import {HydrationRouter} from "../utils/hydration/HydrationRouter.sol";

import {IIntentEmitter} from "./interfaces/IIntentEmitter.sol";

/// @title IntentEmitter — Hydration → Ethereum entry point for NEAR-Intents bridging
/// @notice One stateless entry point: `placeOrder` sells A for WETH and settles it to an Ethereum
///         address over NTT, publishing the forwarding instruction beside it.
///
///         The address it settles toward is `depositAddress`, and this contract has no opinion about
///         where it came from — a `IntentQuoteEmitter` quote derives one, a 1Click quote issues one,
///         and both are served by the same call. See docs/intents/{spec,schema}.md.
///
/// @dev Placing an order needs nothing from off-chain: the rail's delivery price comes out of the swap
///      output, which works because Hydration's native currency is WETH.
contract IntentEmitter is Initializable, UUPSUpgradeable, IIntentEmitter {
    using SafeERC20 for IERC20;

    /// @notice Wormhole chain id of the settlement destination.
    uint16 public constant ETHEREUM_WORMHOLE_ID = 2;

    /// @notice NTT trims to 8 decimals; WETH has 18. The remainder accrues as sweepable dust.
    uint256 public constant TRIM_UNIT = 1e10;

    uint8 public constant CONSISTENCY_FINALIZED = 202;

    IWormhole public wormhole;
    address public owner;
    uint32 public emitterNonce;

    /// @notice NTT manager (WETH) on Hydration.
    address public nttManager;

    /// @notice NTT recipient (ethereum), which forwards to the instruction's `depositAddress`.
    address public intentReceiver;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        _disableInitializers();
    }

    function initialize(address _wormhole) public initializer {
        wormhole = IWormhole(_wormhole);
        owner = msg.sender;
    }

    // ─── Core ────────────────────────────────────────────────────

    /// @inheritdoc IIntentEmitter
    function placeOrder(
        uint32 assetIn,
        uint256 amountIn,
        uint256 minEthOut,
        address depositAddress,
        uint256 maxRelayFee
    ) external returns (uint64 transferSequence) {
        if (amountIn == 0) revert ZeroAmount();
        if (depositAddress == address(0)) revert InvalidDepositAddress();
        if (nttManager == address(0) || intentReceiver == address(0)) revert NotConfigured();

        IERC20 assetInToken = IERC20(HydrationConsts.toErc20(assetIn));
        IERC20 wethToken = IERC20(HydrationConsts.toErc20(HydrationConsts.WETH_ID));

        // Priced before the swap so the router's own floor can be raised by them.
        uint256 cost = _cost();

        // Round the floor down to the rail's precision.
        minEthOut -= minEthOut % TRIM_UNIT;

        uint256 wethInitial = wethToken.balanceOf(address(this));

        assetInToken.safeTransferFrom(msg.sender, address(this), amountIn);

        _swap(assetIn, amountIn, minEthOut + cost);

        uint256 wethOut = wethToken.balanceOf(address(this)) - wethInitial;

        if (wethOut <= cost) revert AmountBelowDeliveryPrice(wethOut, cost);

        uint256 bridgeAmount = wethOut - cost;

        // The remainder stays as dust rather than being refunded — cost more than actual refund.
        bridgeAmount -= bridgeAmount % TRIM_UNIT;

        if (bridgeAmount == 0) revert AmountBelowTrimUnit(bridgeAmount, TRIM_UNIT);
        if (bridgeAmount < minEthOut) revert InsufficientOutput();
        if (maxRelayFee >= bridgeAmount) revert RelayFeeExceedsAmount(maxRelayFee, bridgeAmount);

        transferSequence = _bridge(wethToken, bridgeAmount, depositAddress, maxRelayFee);

        emit OrderPlaced(
            transferSequence, depositAddress, msg.sender, assetIn, amountIn, bridgeAmount, maxRelayFee
        );
    }

    // ─── Helpers ─────────────────────────────────────────────────

    function _cost() internal view returns (uint256) {
        (, uint256 deliveryPrice) = INttManager(nttManager).quoteDeliveryPrice(ETHEREUM_WORMHOLE_ID, hex"00");
        return deliveryPrice + wormhole.messageFee();
    }

    function _dispatch(bytes memory call) internal {
        (bool success,) = HydrationConsts.DISPATCH_PRECOMPILE.call(call);
        if (!success) revert DispatchFailed();
    }

    /// @dev Sell the caller's asset for WETH. No-op when A already is WETH.
    function _swap(uint32 assetIn, uint256 amountIn, uint256 minWethOut) internal {
        if (assetIn == HydrationConsts.WETH_ID) return;

        bytes memory sellForWeth =
            HydrationRouter.encodeSell(assetIn, HydrationConsts.WETH_ID, amountIn, minWethOut);
        _dispatch(sellForWeth);
    }

    /// @dev Settle to the receiver and publish where it forwards.
    function _bridge(
        IERC20 wethToken,
        uint256 amount,
        address depositAddress,
        uint256 maxRelayFee
    ) internal returns (uint64 sequence) {
        (, uint256 deliveryPrice) = INttManager(nttManager).quoteDeliveryPrice(ETHEREUM_WORMHOLE_ID, hex"00");

        wethToken.forceApprove(nttManager, amount);

        // Paused rail or a rate-limit reverts rather than queueing a settlement.
        sequence = INttManager(nttManager).transfer{value: deliveryPrice}(
            amount, ETHEREUM_WORMHOLE_ID, bytes32(uint256(uint160(intentReceiver)))
        );

        bytes memory instruction = abi.encode(sequence, depositAddress, maxRelayFee);
        wormhole.publishMessage{value: wormhole.messageFee()}(
            emitterNonce, instruction, CONSISTENCY_FINALIZED
        );
        emitterNonce++;
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override onlyOwner {}

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    /// @notice Point settlement at the WETH NTT manager.
    /// @dev Reverts unless the manager's token is Hydration WETH.
    function setNttManager(address manager) external onlyOwner {
        address expected = HydrationConsts.toErc20(HydrationConsts.WETH_ID);
        address actual = INttManager(manager).token();
        if (actual != expected) revert SettlementRouteMismatch(expected, actual);
        nttManager = manager;
    }

    /// @notice Point settlements at the Ethereum receiver that forwards them.
    function setIntentReceiver(address receiver) external onlyOwner {
        intentReceiver = receiver;
    }

    /// @notice Recover quantization dust, or any asset sent here by mistake.
    function sweep(address asset, address to, uint256 amount) external onlyOwner {
        IERC20(asset).safeTransfer(to, amount);
        emit Swept(asset, to, amount);
    }
}
