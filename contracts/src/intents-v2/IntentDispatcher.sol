// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {INttManagerWithPayload} from "../ntt/interfaces/INttManagerWithPayload.sol";
import {IAggregatorV3} from "../oracles/interfaces/IAggregatorV3.sol";
import {HydrationConsts} from "../utils/hydration/HydrationConsts.sol";

import {IntentCodec} from "./IntentCodec.sol";
import {IIntentDispatcher} from "./interfaces/IIntentDispatcher.sol";

/// @title IntentDispatcher — intents v2 on Hydration: price, bridge, publish
/// @notice One order: take WETH, price the terms' destination from two USD feeds, bridge it to the
///         Ethereum forwarder over NTT — the forwarding instruction rides in the transfer's payload —
///         and publish the order message NEAR's router swaps against. One call, so a stale feed
///         reverts it before any value leaves. Two entries into the same path:
///
///           - `execute` — ICE's `OnResolved::Forward` callback. The runtime pushes the trade's WETH
///             here first, in the same storage transaction, so a revert hands it back to the user;
///           - `dispatch` — a direct caller's WETH.
///
///         See docs/intents-v2/spec.md §3.
///
/// @dev WETH only: selling another asset is the caller's step — ICE resolves to WETH before its
///      callback, and a direct caller batches `router.sell` with `dispatch`. The rail's costs come out
///      of the WETH, which works because Hydration's native currency is WETH. The router and the
///      forwarder both pin this proxy, so its address never moves.
contract IntentDispatcher is Initializable, UUPSUpgradeable, IIntentDispatcher {
    using SafeERC20 for IERC20;

    /// @notice Wormhole chain id of the settlement destination.
    uint16 public constant ETHEREUM_WORMHOLE_ID = 2;

    /// @notice NTT trims to 8 decimals; WETH has 18. The remainder accrues as sweepable dust.
    uint256 public constant TRIM_UNIT = 1e10;

    /// @notice Orders carry a price the router acts on, so they wait for finality.
    uint8 public constant CONSISTENCY_FINALIZED = 202;

    /// @dev No transceiver instructions — the zero-count prefix NTT expects.
    bytes internal constant NO_INSTRUCTIONS = hex"00";

    IWormhole public wormhole;
    address public owner;
    uint32 public nonce;

    /// @notice Hydration's WETH NTT manager, payload-capable.
    INttManagerWithPayload public nttManager;

    /// @notice The Ethereum forwarder, as a Wormhole universal address — the settlement recipient.
    bytes32 public forwarder;

    /// @notice Oldest feed answer a price may come from, seconds.
    uint256 public maxFeedAge;

    /// @notice POA's minimum ETH deposit, wei. Every order bridges at least this.
    uint256 public minOrderAmount;

    /// @dev keccak256(destinationAsset) → how it is priced.
    mapping(bytes32 => PriceRoute) internal _priceRoutes;

    /// @dev WETH held between calls — trim dust, never an order's. `execute` spends only what
    ///      arrived above it.
    uint256 internal _retained;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ─── Init ────────────────────────────────────────────────────

    constructor() {
        _disableInitializers();
    }

    function initialize(address _wormhole) public initializer {
        wormhole = IWormhole(_wormhole);
        owner = msg.sender;
    }

    // ─── Entries ─────────────────────────────────────────────────

    /// @notice ICE's callback: the resolved trade's WETH, already pushed here, becomes one order of
    ///         the action `data` describes.
    /// @dev `data = abi.encode(address depositAddress, uint256 maxRelayFee, bytes terms)`, the terms
    ///      packed as `IntentCodec` encodes them — the intent's forward data, at most 512 bytes. Called
    ///      with no value and 2M gas. Anyone can call it: it spends only WETH that arrived since the
    ///      last order, so without a push there is nothing to bridge.
    function execute(address, uint256, address, uint256, address assetOut, uint256 amountOut, bytes calldata data)
        external
        returns (bytes4)
    {
        if (assetOut != address(_weth())) revert NotWeth(assetOut);
        if (_weth().balanceOf(address(this)) < _retained + amountOut) revert UnbackedAmount(amountOut);
        (address depositAddress, uint256 maxRelayFee, bytes memory terms) = abi.decode(data, (address, uint256, bytes));

        _placeOrder(amountOut, depositAddress, maxRelayFee, IntentCodec.decodeQuote(terms));
        return this.execute.selector;
    }

    /// @inheritdoc IIntentDispatcher
    function dispatch(uint256 amount, address depositAddress, uint256 maxRelayFee, Quote calldata terms)
        external
        returns (uint64 seq)
    {
        if (amount == 0) revert ZeroAmount();
        _weth().safeTransferFrom(msg.sender, address(this), amount);

        return _placeOrder(amount, depositAddress, maxRelayFee, terms);
    }

    // ─── Views ───────────────────────────────────────────────────

    /// @inheritdoc IIntentDispatcher
    function outPerIn(string calldata destinationAsset) external view returns (uint128) {
        return _outPerIn(destinationAsset);
    }

    /// @inheritdoc IIntentDispatcher
    function computeAuthPath(Quote calldata terms) external pure returns (bytes32) {
        return keccak256(IntentCodec.encodeQuote(terms));
    }

    /// @inheritdoc IIntentDispatcher
    function computeTerms(Quote calldata terms) external pure returns (bytes memory) {
        return IntentCodec.encodeQuote(terms);
    }

    /// @notice How `destinationAsset` is priced; zero addresses if it is not.
    function priceRoute(string calldata destinationAsset) external view returns (PriceRoute memory) {
        return _priceRoutes[keccak256(bytes(destinationAsset))];
    }

    // ─── Helpers ─────────────────────────────────────────────────

    /// @dev Hydration WETH's ERC20 precompile — the only asset an order carries.
    function _weth() internal pure returns (IERC20) {
        return IERC20(HydrationConsts.toErc20(HydrationConsts.WETH_ID));
    }

    /// @dev A positive answer no older than `maxFeedAge`.
    function _readFeed(address feed) internal view returns (uint256 answer, uint8 decimals) {
        (, int256 value,, uint256 updatedAt,) = IAggregatorV3(feed).latestRoundData();
        if (value <= 0) revert InvalidFeedAnswer(feed, value);
        if (block.timestamp > updatedAt + maxFeedAge) revert StaleFeed(feed, updatedAt);
        return (uint256(value), IAggregatorV3(feed).decimals());
    }

    /// @dev Price, bridge and publish one order of `weth`. The price is read first, so a missing
    ///      route or a stale feed reverts before anything moves.
    function _placeOrder(uint256 weth, address depositAddress, uint256 maxRelayFee, Quote memory terms)
        internal
        returns (uint64 seq)
    {
        if (address(nttManager) == address(0) || forwarder == bytes32(0)) revert NotConfigured();
        if (depositAddress == address(0)) revert InvalidDepositAddress();
        if (msg.sender != terms.owner) revert NotTermsOwner(msg.sender, terms.owner);

        Order memory order;
        order.outPerIn = _outPerIn(terms.destinationAsset);
        bytes memory encoded = IntentCodec.encodeQuote(terms);
        bytes32 authPath = keccak256(encoded);

        uint256 fee = wormhole.messageFee();
        (order.seq, order.amount) = _bridge(weth, fee, depositAddress, maxRelayFee);

        uint64 messageSequence =
            wormhole.publishMessage{value: fee}(nonce, IntentCodec.encodeOrder(authPath, order), CONSISTENCY_FINALIZED);
        nonce++;
        _retained = _weth().balanceOf(address(this));

        emit OrderPublished(
            authPath, order.seq, msg.sender, depositAddress, order.amount, order.outPerIn, messageSequence, encoded
        );
        return order.seq;
    }

    /// @dev Bridge `weth` less the rail's delivery price and the order message's `fee`, trimmed, to
    ///      the forwarder, with the forwarding instruction as the transfer's payload. What bridges
    ///      must be at least POA's minimum deposit plus the relay ceiling, and the ceiling at most
    ///      half of it: whatever the relayer keeps, `A` receives at least the order's amount and at
    ///      most twice it — one fill at the router's `max_fill_multiple` of 2.
    /// @return seq The transfer's NTT message id
    /// @return amount The least `A` receives: what bridged less the relay ceiling
    function _bridge(uint256 weth, uint256 fee, address depositAddress, uint256 maxRelayFee)
        internal
        returns (uint64 seq, uint128 amount)
    {
        (, uint256 deliveryPrice) = nttManager.quoteDeliveryPrice(ETHEREUM_WORMHOLE_ID, NO_INSTRUCTIONS);
        if (weth <= deliveryPrice + fee) revert AmountBelowCost(weth, deliveryPrice + fee);

        // Round the floor up to the rail's precision.
        uint256 minimum = Math.ceilDiv(minOrderAmount + maxRelayFee, TRIM_UNIT) * TRIM_UNIT;

        // The remainder stays as dust rather than being refunded — cost more than the refund.
        uint256 bridgeAmount = weth - deliveryPrice - fee;
        bridgeAmount -= bridgeAmount % TRIM_UNIT;
        if (bridgeAmount < minimum) revert AmountBelowMinimum(bridgeAmount, minimum);
        if (maxRelayFee * 2 > bridgeAmount) revert RelayFeeTooHigh(maxRelayFee, bridgeAmount);

        _weth().forceApprove(address(nttManager), bridgeAmount);

        seq = nttManager.transferWithPayload{value: deliveryPrice}(
            bridgeAmount, ETHEREUM_WORMHOLE_ID, forwarder, IntentCodec.encodeForward(depositAddress, maxRelayFee)
        );
        // The relayer keeps up to the ceiling on Ethereum; the router credits on what is left.
        amount = uint128(bridgeAmount - maxRelayFee);
    }

    function _outPerIn(string memory destinationAsset) internal view returns (uint128) {
        PriceRoute memory route = _priceRoutes[keccak256(bytes(destinationAsset))];
        if (route.ethFeed == address(0)) revert UnpricedAsset(destinationAsset);

        (uint256 ethUsd, uint8 ethDecimals) = _readFeed(route.ethFeed);
        (uint256 destUsd, uint8 destFeedDecimals) = _readFeed(route.destFeed);

        // dest units per 1e18 wei = ethUsd / destUsd × 10^destDecimals, each USD price at its own
        // feed's decimals.
        uint256 rate =
            Math.mulDiv(ethUsd * 10 ** destFeedDecimals, 10 ** route.destDecimals, destUsd * 10 ** ethDecimals);
        if (rate == 0 || rate > type(uint128).max) revert InvalidRate(rate);
        return uint128(rate);
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override onlyOwner {}

    // ─── Admin ───────────────────────────────────────────────────

    /// @inheritdoc IIntentDispatcher
    function setPriceRoute(string calldata destinationAsset, PriceRoute calldata route) external onlyOwner {
        _priceRoutes[keccak256(bytes(destinationAsset))] = route;
        emit PriceRouteSet(destinationAsset, route.ethFeed, route.destFeed, route.destDecimals);
    }

    /// @inheritdoc IIntentDispatcher
    function setMaxFeedAge(uint256 _maxFeedAge) external onlyOwner {
        maxFeedAge = _maxFeedAge;
        emit MaxFeedAgeSet(_maxFeedAge);
    }

    /// @inheritdoc IIntentDispatcher
    function setMinOrderAmount(uint256 _minOrderAmount) external onlyOwner {
        minOrderAmount = _minOrderAmount;
        emit MinOrderAmountSet(_minOrderAmount);
    }

    /// @inheritdoc IIntentDispatcher
    /// @dev Reverts unless the manager's token is Hydration WETH.
    function setNttManager(address manager) external onlyOwner {
        address expected = address(_weth());
        address actual = INttManagerWithPayload(manager).token();
        if (actual != expected) revert SettlementRouteMismatch(expected, actual);
        nttManager = INttManagerWithPayload(manager);
        emit NttManagerSet(manager);
    }

    /// @inheritdoc IIntentDispatcher
    function setForwarder(bytes32 _forwarder) external onlyOwner {
        forwarder = _forwarder;
        emit ForwarderSet(_forwarder);
    }

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    /// @notice Recover quantization dust, or any asset sent here by mistake.
    function sweep(address asset, address to, uint256 amount) external onlyOwner {
        IERC20(asset).safeTransfer(to, amount);
        if (asset == address(_weth())) _retained = _weth().balanceOf(address(this));
        emit Swept(asset, to, amount);
    }
}
