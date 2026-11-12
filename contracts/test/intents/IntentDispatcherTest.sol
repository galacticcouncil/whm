// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {IntentDispatcher} from "../../src/intents/IntentDispatcher.sol";
import {IntentCodec} from "../../src/intents/IntentCodec.sol";
import {IIntentDispatcher} from "../../src/intents/interfaces/IIntentDispatcher.sol";
import {HydrationConsts} from "../../src/utils/hydration/HydrationConsts.sol";

import {MockERC20} from "../mocks/MockERC20.sol";
import {MockNttManagerWithPayload} from "../mocks/MockNttManagerWithPayload.sol";
import {MockCoreBridge} from "./IntentEmitterTest.sol";

contract MockFeed {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 d, int256 a) {
        decimals = d;
        answer = a;
        updatedAt = block.timestamp;
    }

    function set(int256 a, uint256 u) external {
        answer = a;
        updatedAt = u;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/// @title IntentDispatcherTest
/// @notice intents v2 on Hydration in one contract: WETH in, priced from the feeds, bridged over NTT
///         with the forwarding instruction as the transfer's payload, and the order message out — the
///         bytes the Ethereum forwarder and NEAR's router read. A missing or stale price stops it
///         before value leaves; the rail's costs come out of the WETH; nothing stays behind.
contract IntentDispatcherTest is Test {
    string constant ZEC = "nep141:zec.omft.near";
    string constant NEAR = "nep141:wrap.near";
    uint256 constant MIN_ORDER_AMOUNT = 1e11;
    uint256 constant MAX_FEED_AGE = 21_600;
    bytes32 constant FORWARDER = bytes32(uint256(uint160(0xF0F0)));

    IntentDispatcher public dispatcher;
    MockNttManagerWithPayload public nttManager;
    MockCoreBridge public coreBridge;
    MockERC20 public weth;
    MockFeed public ethUsd;
    MockFeed public zecUsd;

    address public user = makeAddr("user");
    address public depositAddress = makeAddr("depositAddress");

    function setUp() public {
        vm.warp(1_800_000_000 - 86_400);

        deployCodeTo("MockERC20.sol:MockERC20", HydrationConsts.toErc20(HydrationConsts.WETH_ID));
        weth = MockERC20(HydrationConsts.toErc20(HydrationConsts.WETH_ID));
        coreBridge = new MockCoreBridge();
        nttManager = new MockNttManagerWithPayload(address(weth));

        dispatcher = IntentDispatcher(
            address(
                new ERC1967Proxy(
                    address(new IntentDispatcher()), abi.encodeCall(IntentDispatcher.initialize, (address(coreBridge)))
                )
            )
        );
        dispatcher.setNttManager(address(nttManager));
        dispatcher.setForwarder(FORWARDER);

        // ETH $3000, ZEC $50, both 8 decimals: 60 ZEC per ETH.
        ethUsd = new MockFeed(8, 3_000e8);
        zecUsd = new MockFeed(8, 50e8);
        dispatcher.setPriceRoute(ZEC, IIntentDispatcher.PriceRoute(address(ethUsd), address(zecUsd), 8));
        dispatcher.setMaxFeedAge(MAX_FEED_AGE);
        dispatcher.setMinOrderAmount(MIN_ORDER_AMOUNT);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _terms() internal view returns (IIntentDispatcher.Quote memory) {
        return IIntentDispatcher.Quote({
            owner: user,
            quoteId: keccak256("action-1"),
            maxSlippageBps: 100,
            minOutPerIn: 0,
            minDelivery: 1_000_000,
            deadline: 1_800_000_000,
            recipientKind: IntentCodec.KIND_WITHDRAW,
            refundTo: address(0x2222222222222222222222222222222222222222),
            destinationAsset: ZEC,
            recipient: "t1KPVSRgnFHPBWMJLC7taJioN6m5Q6jVBma"
        });
    }

    /// @dev The user holds `amount` WETH, approved to the dispatcher. Hydration's native currency is
    ///      WETH: what reaches the dispatcher is in its native balance too, and the rail's costs are
    ///      paid from it. Two mocks cannot share a balance, so the native side is dealt.
    function _fund(uint256 amount) internal {
        weth.mint(user, amount);
        vm.deal(address(dispatcher), address(dispatcher).balance + amount);
        vm.prank(user);
        weth.approve(address(dispatcher), amount);
    }

    /// @dev What the lazy executor does before `execute`: push `amountOut` WETH to the dispatcher.
    function _push(uint256 amountOut) internal {
        weth.mint(address(dispatcher), amountOut);
        vm.deal(address(dispatcher), address(dispatcher).balance + amountOut);
    }

    function _data(uint256 maxRelayFee) internal view returns (bytes memory) {
        return abi.encode(depositAddress, maxRelayFee, dispatcher.computeTerms(_terms()));
    }

    function _orderAmount() internal view returns (uint256 amount) {
        bytes memory payload = coreBridge.lastPayload();
        for (uint256 i = 41; i < 57; i++) {
            amount = (amount << 8) | uint8(payload[i]);
        }
    }

    function _decodeForward(bytes memory p) internal pure returns (address d, uint256 fee) {
        uint256 a;
        for (uint256 i = 1; i < 21; i++) {
            a = (a << 8) | uint8(p[i]);
        }
        d = address(uint160(a));
        for (uint256 i = 21; i < 37; i++) {
            fee = (fee << 8) | uint8(p[i]);
        }
    }

    // ─── Dispatch ───────────────────────────────────────────────────

    /// @notice One call: NTT carries the ETH to the forwarder with the forwarding instruction as its
    ///         payload, and the order message carries the path, the transfer's id, exactly what
    ///         bridged, and the oracle rate.
    function testDispatchBridgesAndPublishes() public {
        uint256 amount = 1e15 + 7; // 7 wei of trim dust
        bytes32 path = dispatcher.computeAuthPath(_terms());
        bytes memory terms = dispatcher.computeTerms(_terms());
        _fund(amount);

        vm.expectEmit(true, true, true, true, address(dispatcher));
        emit IIntentDispatcher.OrderPublished(path, 0, user, depositAddress, 1e15, 6e9, 42, terms);
        vm.prank(user);
        uint64 seq = dispatcher.dispatch(amount, depositAddress, 0, _terms());

        MockNttManagerWithPayload.TransferRecord memory t = nttManager.transfers(seq);
        assertEq(t.amount, 1e15, "bridged, trimmed");
        assertEq(t.recipientChain, 2, "to Ethereum");
        assertEq(t.recipient, FORWARDER, "settles to the forwarder");
        assertEq(t.payload, abi.encodePacked(uint8(1), depositAddress, uint128(0)), "forward payload");

        assertEq(coreBridge.lastPayload(), abi.encodePacked(uint8(1), path, seq, uint128(1e15), uint128(6e9)), "order");
        assertEq(coreBridge.lastConsistency(), 202, "finalized");
        assertEq(weth.balanceOf(address(dispatcher)), 7, "only the trim dust stays");
    }

    /// @notice The rail's delivery price and the order message's fee come out of the WETH, and the
    ///         order carries what actually bridged.
    function testCostsComeOutOfTheWeth() public {
        nttManager.setDeliveryPrice(3e10 + 5);
        coreBridge.setFee(7);
        _fund(1e15);
        vm.prank(user);
        uint64 seq = dispatcher.dispatch(1e15, depositAddress, 0, _terms());

        uint256 expected = 1e15 - 3e10 - 12;
        expected -= expected % 1e10;
        MockNttManagerWithPayload.TransferRecord memory t = nttManager.transfers(seq);
        assertEq(t.amount, expected, "bridged after costs");
        assertEq(t.value, 3e10 + 5, "delivery price paid");
        assertEq(coreBridge.lastValue(), 7, "message fee paid");
        assertEq(_orderAmount(), expected, "the order carries the exact amount");
    }

    /// @notice A stranger cannot place an order on another user's terms, even paying for it — it would
    ///         spend that user's `A` at a moment of the stranger's choosing.
    function testDispatchRefusesAnotherOwnersTerms() public {
        address stranger = makeAddr("stranger");
        weth.mint(stranger, 1e15);
        vm.prank(stranger);
        weth.approve(address(dispatcher), 1e15);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IIntentDispatcher.NotTermsOwner.selector, stranger, user));
        dispatcher.dispatch(1e15, depositAddress, 0, _terms());
    }

    /// @notice The order carries what `A` receives at least — the bridged amount less the relay
    ///         ceiling — so it credits whatever the relayer keeps.
    function testOrderCarriesTheAmountNetOfTheRelayCeiling() public {
        _fund(1e15);
        vm.prank(user);
        uint64 seq = dispatcher.dispatch(1e15, depositAddress, 5e10, _terms());
        assertEq(nttManager.transfers(seq).amount, 1e15, "bridged in full");
        assertEq(_orderAmount(), 1e15 - 5e10, "the order is net of the ceiling");
    }

    /// @notice The relayer may keep at most half: then `A` receives at least the order and at most
    ///         twice it, one router fill.
    function testRelayCeilingIsAtMostHalf() public {
        _fund(1e15);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IIntentDispatcher.RelayFeeTooHigh.selector, 5e14 + 1, 1e15));
        dispatcher.dispatch(1e15, depositAddress, 5e14 + 1, _terms());

        vm.prank(user);
        dispatcher.dispatch(1e15, depositAddress, 5e14, _terms());
        assertEq(_orderAmount(), 5e14, "half kept back");
    }

    function testRelayCeilingTravelsInThePayload() public {
        _fund(1e15);
        vm.prank(user);
        uint64 seq = dispatcher.dispatch(1e15, depositAddress, 5e10, _terms());
        (address d, uint256 fee) = _decodeForward(nttManager.transfers(seq).payload);
        assertEq(d, depositAddress);
        assertEq(fee, 5e10);
    }

    // ─── ICE callback ───────────────────────────────────────────────

    function testForwardDataFitsIce() public view {
        assertLe(_data(0).length, 512);
    }

    /// @notice The resolved trade's WETH becomes one order, acknowledged with the selector.
    function testExecuteBridgesThePushedWeth() public {
        bytes memory data = _data(0);
        bytes32 path = dispatcher.computeAuthPath(_terms());
        bytes memory terms = dispatcher.computeTerms(_terms());
        _push(1e15 + 3);

        vm.expectEmit(true, true, true, true, address(dispatcher));
        emit IIntentDispatcher.OrderPublished(path, 0, user, depositAddress, 1e15, 6e9, 42, terms);
        vm.prank(user, user);
        bytes4 ack = dispatcher.execute(user, 7, address(0x1234), 5e18, address(weth), 1e15 + 3, data);

        assertEq(ack, dispatcher.execute.selector, "ack");
        assertEq(nttManager.transfers(0).amount, 1e15, "bridged");
        assertEq(weth.balanceOf(address(dispatcher)), 3, "only the trim dust stays");
    }

    /// @notice Only a trade into WETH becomes an order; anything else reverts, and the runtime rolls
    ///         the push back to the user.
    function testExecuteRefusesOtherAssets() public {
        bytes memory data = _data(0);
        vm.prank(user, user);
        vm.expectRevert(abi.encodeWithSelector(IIntentDispatcher.NotWeth.selector, address(0x1234)));
        dispatcher.execute(user, 7, address(weth), 1e15, address(0x1234), 1e15, data);
    }

    /// @notice A call with no push behind it has nothing to bridge: the dust earlier orders left is
    ///         not the caller's.
    function testExecuteWithoutAPushBridgesNothing() public {
        _fund(1e15 + 9);
        vm.prank(user);
        dispatcher.dispatch(1e15 + 9, depositAddress, 0, _terms());
        assertEq(weth.balanceOf(address(dispatcher)), 9, "dust");

        bytes memory data = _data(0);
        vm.prank(user, user);
        vm.expectRevert(abi.encodeWithSelector(IIntentDispatcher.UnbackedAmount.selector, 1e15));
        dispatcher.execute(user, 7, address(0x1234), 5e18, address(weth), 1e15, data);
        assertEq(nttManager.nextSequence(), 1, "nothing more bridged");
    }

    /// @notice A caller who pushes its own WETH cannot claim the dust on top: `execute` spends only
    ///         what arrived since the last order.
    function testExecuteCannotClaimRetainedDust() public {
        _fund(1e15 + 9);
        vm.prank(user);
        dispatcher.dispatch(1e15 + 9, depositAddress, 0, _terms());

        bytes memory data = _data(0);
        _push(1e15);
        vm.prank(user, user);
        vm.expectRevert(abi.encodeWithSelector(IIntentDispatcher.UnbackedAmount.selector, 1e15 + 9));
        dispatcher.execute(user, 7, address(0x1234), 5e18, address(weth), 1e15 + 9, data);

        vm.prank(user, user);
        dispatcher.execute(user, 7, address(0x1234), 5e18, address(weth), 1e15, data);
        assertEq(nttManager.transfers(1).amount, 1e15, "only the push bridged");
        assertEq(weth.balanceOf(address(dispatcher)), 9, "the dust stays");
    }

    /// @notice Sweeping the dust lowers what is retained, so the next push still spends in full.
    function testSweepReleasesRetainedDust() public {
        _fund(1e15 + 9);
        vm.prank(user);
        dispatcher.dispatch(1e15 + 9, depositAddress, 0, _terms());
        dispatcher.sweep(address(weth), address(this), 9);

        bytes memory data = _data(0);
        _push(1e15);
        vm.prank(user, user);
        dispatcher.execute(user, 7, address(0x1234), 5e18, address(weth), 1e15, data);
        assertEq(nttManager.transfers(1).amount, 1e15, "bridged");
    }

    /// @notice Only the terms' owner places their orders — ICE calls as the owner, so a stranger
    ///         calling `execute` with someone else's terms is refused, even with its own WETH pushed.
    function testExecuteRefusesAnotherOwnersTerms() public {
        address stranger = makeAddr("stranger");
        bytes memory data = _data(0);
        _push(1e15);
        vm.prank(stranger, stranger);
        vm.expectRevert(abi.encodeWithSelector(IIntentDispatcher.NotTermsOwner.selector, stranger, user));
        dispatcher.execute(stranger, 7, address(0x1234), 5e18, address(weth), 1e15, data);
    }

    /// @notice A stale price reverts the callback, so the runtime returns the WETH to the user.
    function testExecuteFailsClosedOnAStaleFeed() public {
        vm.warp(block.timestamp + MAX_FEED_AGE + 1);
        bytes memory data = _data(0);
        _push(1e15);
        vm.prank(user, user);
        vm.expectRevert(
            abi.encodeWithSelector(IIntentDispatcher.StaleFeed.selector, address(ethUsd), block.timestamp - MAX_FEED_AGE - 1)
        );
        dispatcher.execute(user, 7, address(0x1234), 5e18, address(weth), 1e15, data);
    }

    function testExecuteRefusesMalformedTerms() public {
        bytes memory bad = abi.encode(depositAddress, uint256(0), hex"02");
        _push(1e15);
        vm.prank(user, user);
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.MalformedTerms.selector, 1));
        dispatcher.execute(user, 7, address(0x1234), 5e18, address(weth), 1e15, bad);
    }

    // ─── Price ──────────────────────────────────────────────────────

    function testRateAcrossDecimals() public {
        assertEq(dispatcher.outPerIn(ZEC), 6e9, "60 ZEC per ETH at 8 decimals");

        MockFeed zec18 = new MockFeed(18, 50e18);
        dispatcher.setPriceRoute(ZEC, IIntentDispatcher.PriceRoute(address(ethUsd), address(zec18), 8));
        assertEq(dispatcher.outPerIn(ZEC), 6e9, "feed decimals cancel");

        MockFeed nearUsd = new MockFeed(8, 2.5e8);
        dispatcher.setPriceRoute(NEAR, IIntentDispatcher.PriceRoute(address(ethUsd), address(nearUsd), 24));
        assertEq(dispatcher.outPerIn(NEAR), 1200e24, "24-decimal destination");
    }

    function testStaleFeedFailsClosed() public {
        vm.warp(block.timestamp + MAX_FEED_AGE + 1);
        _fund(1e15);
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(IIntentDispatcher.StaleFeed.selector, address(ethUsd), block.timestamp - MAX_FEED_AGE - 1)
        );
        dispatcher.dispatch(1e15, depositAddress, 0, _terms());
        assertEq(nttManager.nextSequence(), 0, "nothing bridged");
    }

    function testInvalidAnswersAreRefused() public {
        zecUsd.set(0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(IIntentDispatcher.InvalidFeedAnswer.selector, address(zecUsd), int256(0)));
        dispatcher.outPerIn(ZEC);

        zecUsd.set(-1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(IIntentDispatcher.InvalidFeedAnswer.selector, address(zecUsd), int256(-1)));
        dispatcher.outPerIn(ZEC);
    }

    function testUnpricedAssetIsRefused() public {
        IIntentDispatcher.Quote memory t = _terms();
        t.destinationAsset = "nep141:btc.omft.near";
        _fund(1e15);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IIntentDispatcher.UnpricedAsset.selector, "nep141:btc.omft.near"));
        dispatcher.dispatch(1e15, depositAddress, 0, t);
    }

    // ─── Floors ─────────────────────────────────────────────────────

    /// @notice An order always credits on POA: what bridges is at least its minimum deposit plus the
    ///         relay ceiling, in whole trim units.
    function testBridgedAmountCoversMinOrderAndRelayFee() public {
        uint256 maxRelayFee = 5e10 + 3; // floor: ceil(1.5e11 + 3) to 1e10 = 1.6e11
        _fund(1.6e11 - 1);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IIntentDispatcher.AmountBelowMinimum.selector, 1.5e11, 1.6e11));
        dispatcher.dispatch(1.6e11 - 1, depositAddress, maxRelayFee, _terms());

        _fund(1);
        vm.startPrank(user);
        weth.approve(address(dispatcher), 1.6e11);
        dispatcher.dispatch(1.6e11, depositAddress, maxRelayFee, _terms());
        vm.stopPrank();
    }

    function testCostAboveTheWethReverts() public {
        nttManager.setDeliveryPrice(1e15);
        _fund(1e15);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IIntentDispatcher.AmountBelowCost.selector, 1e15, 1e15));
        dispatcher.dispatch(1e15, depositAddress, 0, _terms());
    }

    // ─── Config ─────────────────────────────────────────────────────

    function testUnconfiguredDispatcherBridgesNothing() public {
        dispatcher.setForwarder(bytes32(0));
        _fund(1e15);
        vm.prank(user);
        vm.expectRevert(IIntentDispatcher.NotConfigured.selector);
        dispatcher.dispatch(1e15, depositAddress, 0, _terms());
    }

    function testNttManagerMustCarryWeth() public {
        MockNttManagerWithPayload other = new MockNttManagerWithPayload(address(0xDEAD));
        vm.expectRevert(
            abi.encodeWithSelector(IIntentDispatcher.SettlementRouteMismatch.selector, address(weth), address(0xDEAD))
        );
        dispatcher.setNttManager(address(other));
    }

    function testOnlyTheOwnerConfigures() public {
        vm.startPrank(user);
        vm.expectRevert(IIntentDispatcher.NotOwner.selector);
        dispatcher.setPriceRoute(ZEC, IIntentDispatcher.PriceRoute(address(1), address(1), 8));
        vm.expectRevert(IIntentDispatcher.NotOwner.selector);
        dispatcher.setMaxFeedAge(1);
        vm.expectRevert(IIntentDispatcher.NotOwner.selector);
        dispatcher.setMinOrderAmount(1);
        vm.expectRevert(IIntentDispatcher.NotOwner.selector);
        dispatcher.setForwarder(bytes32(uint256(1)));
        vm.expectRevert(IIntentDispatcher.NotOwner.selector);
        dispatcher.setNttManager(address(nttManager));
        vm.stopPrank();
        address impl = address(new IntentDispatcher());
        vm.prank(user);
        vm.expectRevert(IIntentDispatcher.NotOwner.selector);
        dispatcher.upgradeToAndCall(impl, "");
    }
}
