// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {IntentEmitter} from "../../src/intents/IntentEmitter.sol";
import {IIntentEmitter} from "../../src/intents/interfaces/IIntentEmitter.sol";
import {HydrationConsts} from "../../src/utils/hydration/HydrationConsts.sol";

import {MockERC20} from "../mocks/MockERC20.sol";
import {MockNttManager} from "../mocks/MockNttManager.sol";

/// @dev Stands in for the DISPATCH precompile: any call mints the configured WETH to the caller,
///      which is what a successful `router.sell` looks like from the emitter's point of view.
///
///      It mints the native side too. Hydration's native currency *is* WETH (asset 20) — one
///      balance behind two interfaces — and the emitter relies on that to pay the rail's delivery
///      price out of the swap output. Two unrelated mocks cannot share a balance, so the identity
///      is reproduced here with a cheatcode.
contract MockDispatch {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address public weth;
    uint256 public out;
    bytes public lastCall;

    function configure(address _weth, uint256 _out) external {
        weth = _weth;
        out = _out;
    }

    fallback() external {
        lastCall = msg.data;
        if (out > 0) {
            MockERC20(weth).mint(msg.sender, out);
            VM.deal(msg.sender, msg.sender.balance + out);
        }
    }
}

/// @dev Records what was published, and can be given a non-zero message fee.
contract MockCoreBridge {
    uint256 public fee;
    uint64 public nextSequence = 42;

    bytes public lastPayload;
    uint32 public lastNonce;
    uint8 public lastConsistency;
    uint256 public lastValue;

    function setFee(uint256 _fee) external {
        fee = _fee;
    }

    function messageFee() external view returns (uint256) {
        return fee;
    }

    function publishMessage(uint32 nonce, bytes memory payload, uint8 consistencyLevel)
        external
        payable
        returns (uint64 sequence)
    {
        lastNonce = nonce;
        lastPayload = payload;
        lastConsistency = consistencyLevel;
        lastValue = msg.value;

        sequence = nextSequence;
        nextSequence++;
    }
}

/// @title IntentEmitterTest
/// @notice Pins the three properties the design rests on:
///
///           1. the derivation path is a function of the terms, so an authorization can only ever
///              reach the account its own recipient implies;
///           2. placing an order needs nothing from off-chain — no quote, no value, and the rail's
///              delivery price comes out of the swap output;
///           3. what it promises is what the rail can carry (quantization), and `minEthOut` is a
///              floor on what *arrives* rather than on the swap.
contract IntentEmitterTest is Test {
    uint32 constant ASSET_IN = 5; // any non-WETH Hydration asset
    uint256 constant TRIM_UNIT = 1e10;
    uint256 constant DUST = 7 wei;
    /// @dev Deliberately not a multiple of TRIM_UNIT: quantization has to happen *after* the
    ///      delivery price is deducted, and a round fee would hide the difference.
    uint256 constant DELIVERY_PRICE = 2 * TRIM_UNIT + 5;

    IntentEmitter public emitter;
    MockNttManager public nttManager;
    MockCoreBridge public coreBridge;
    MockERC20 public weth;
    MockERC20 public assetIn;
    MockDispatch public dispatch;

    address public user = makeAddr("user");
    address public depositAddress = makeAddr("depositAddress");
    address public intentReceiver = makeAddr("intentReceiver");
    bytes32 public orderId = keccak256("schedule-1");

    /// @dev Zero for most cases: the fee ceiling only matters where a test asserts on it, and a
    ///      non-zero default would have to be subtracted from every quantization assertion.
    uint256 constant MAX_RELAY_FEE = 0;

    function setUp() public {
        // Hydration exposes assets as ERC20 precompiles at fixed addresses, so the mocks have to
        // live at those addresses rather than wherever `new` puts them.
        deployCodeTo("MockERC20.sol:MockERC20", HydrationConsts.toErc20(HydrationConsts.WETH_ID));
        deployCodeTo("MockERC20.sol:MockERC20", HydrationConsts.toErc20(ASSET_IN));
        weth = MockERC20(HydrationConsts.toErc20(HydrationConsts.WETH_ID));
        assetIn = MockERC20(HydrationConsts.toErc20(ASSET_IN));

        deployCodeTo("IntentEmitterTest.sol:MockDispatch", HydrationConsts.DISPATCH_PRECOMPILE);
        dispatch = MockDispatch(HydrationConsts.DISPATCH_PRECOMPILE);

        coreBridge = new MockCoreBridge();

        emitter = IntentEmitter(
            address(
                new ERC1967Proxy(
                    address(new IntentEmitter()),
                    abi.encodeCall(IntentEmitter.initialize, (address(coreBridge)))
                )
            )
        );

        nttManager = new MockNttManager(address(weth));
        nttManager.setDeliveryPrice(DELIVERY_PRICE);
        emitter.setNttManager(address(nttManager));
        emitter.setIntentReceiver(intentReceiver);

        vm.deal(user, 100 ether);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _bridge(uint256 amountIn, uint256 minEthOut) internal returns (uint64 sequence) {
        weth.mint(user, amountIn);
        vm.deal(address(emitter), address(emitter).balance + amountIn);

        vm.startPrank(user);
        weth.approve(address(emitter), amountIn);
        sequence = emitter.placeOrder(HydrationConsts.WETH_ID, amountIn, minEthOut, depositAddress, MAX_RELAY_FEE);
        vm.stopPrank();
    }

    /// @dev Bridge through the swap path: the router produces `out` WETH for `amountIn` of ASSET_IN.
    function _swapBridge(uint256 amountIn, uint256 out, uint256 minEthOut)
        internal
        returns (uint64 sequence)
    {
        dispatch.configure(address(weth), out);
        assetIn.mint(user, amountIn);

        vm.startPrank(user);
        assetIn.approve(address(emitter), amountIn);
        sequence = emitter.placeOrder(ASSET_IN, amountIn, minEthOut, depositAddress, MAX_RELAY_FEE);
        vm.stopPrank();
    }

    function _routerFloor() internal view returns (uint256 floor) {
        bytes memory call = dispatch.lastCall();
        for (uint256 i = 0; i < 16; i++) {
            floor |= uint256(uint8(call[26 + i])) << (8 * i);
        }
    }

    // ─── Self-funded delivery ───────────────────────────────────────

    /// @notice The property that makes an on-chain scheduler viable: the caller sends no value, and
    ///         the rail's delivery price is deducted from what the swap produced.
    function testDeliveryPriceComesOutOfSwapOutput() public {
        uint64 sequence = _bridge(5 * TRIM_UNIT + DELIVERY_PRICE, 0);

        assertEq(nttManager.getTransfer(sequence).amount, 5 * TRIM_UNIT, "delivery price not deducted");
        assertEq(address(nttManager).balance, DELIVERY_PRICE, "rail underpaid");
        assertEq(address(emitter).balance, 5 * TRIM_UNIT, "emitter must pay exactly the quote");
    }

    /// @notice `minEthOut` is a floor on what arrives, so the floor handed to the router has to be
    ///         raised by the delivery price that output still has to cover.
    function testRouterFloorIsRaisedByDeliveryPrice() public {
        _swapBridge(100e6, 5 * TRIM_UNIT + DELIVERY_PRICE, 5 * TRIM_UNIT);

        assertEq(_routerFloor(), 5 * TRIM_UNIT + DELIVERY_PRICE, "router floor must cover delivery");
    }

    /// @notice A value carrying digits finer than the rail can represent binds at the multiple
    ///         below it — otherwise an exact fill at the floor would be trimmed under it and revert.
    function testFloorIsQuantizedDownwards() public {
        _swapBridge(100e6, 5 * TRIM_UNIT + DELIVERY_PRICE, 5 * TRIM_UNIT + DUST);

        assertEq(_routerFloor(), 5 * TRIM_UNIT + DELIVERY_PRICE, "floor must round down to the rail");
    }

    function testAmountBelowDeliveryPriceReverts() public {
        weth.mint(user, DELIVERY_PRICE);
        vm.deal(address(emitter), DELIVERY_PRICE);

        vm.startPrank(user);
        weth.approve(address(emitter), DELIVERY_PRICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                IIntentEmitter.AmountBelowDeliveryPrice.selector, DELIVERY_PRICE, DELIVERY_PRICE
            )
        );
        emitter.placeOrder(HydrationConsts.WETH_ID, DELIVERY_PRICE, 0, depositAddress, MAX_RELAY_FEE);
        vm.stopPrank();
    }

    // ─── Quantization ───────────────────────────────────────────────

    /// @notice The rail trims to 8 decimals, so the source must round down before promising an
    ///         amount: what settles has to equal what is released.
    function testQuantizesToTrimUnit() public {
        uint256 amountIn = 3 * TRIM_UNIT + DELIVERY_PRICE + DUST;
        uint64 sequence = _bridge(amountIn, 0);

        assertEq(nttManager.getTransfer(sequence).amount, 3 * TRIM_UNIT, "settlement must be quantized");
        // The emitter keeps what it did not bridge. DELIVERY_PRICE left on the native side, which
        // these two mocks cannot debit from the ERC20 side; the real dust is the remainder.
        assertEq(
            weth.balanceOf(address(emitter)) - DELIVERY_PRICE, DUST, "remainder must stay as dust"
        );
    }

    function testAmountBelowTrimUnitReverts() public {
        uint256 amountIn = DELIVERY_PRICE + TRIM_UNIT - 1;
        weth.mint(user, amountIn);
        vm.deal(address(emitter), amountIn);

        vm.startPrank(user);
        weth.approve(address(emitter), amountIn);
        vm.expectRevert(abi.encodeWithSelector(IIntentEmitter.AmountBelowTrimUnit.selector, 0, TRIM_UNIT));
        emitter.placeOrder(HydrationConsts.WETH_ID, amountIn, 0, depositAddress, MAX_RELAY_FEE);
        vm.stopPrank();
    }

    function testSweepRecoversDust() public {
        _bridge(TRIM_UNIT + DELIVERY_PRICE + DUST, 0);

        emitter.sweep(address(weth), address(this), DUST);
        assertEq(weth.balanceOf(address(this)), DUST, "dust not recoverable");
    }

    // ─── Settlement shape ───────────────────────────────────────────

    /// @notice An order is just "settle to this address". For an authorized route the scheduler
    ///         holds a deposit address that never changes, so firing one needs no off-chain input.
    /// @notice The settlement goes to the receiver, not the deposit address — NTT carries no payload,
    ///         so the destination travels as its own message and the two are matched on the sequence.
    function testSettlementAddressedToReceiver() public {
        uint64 sequence = _bridge(TRIM_UNIT + DELIVERY_PRICE, 0);

        MockNttManager.TransferRecord memory settled = nttManager.getTransfer(sequence);
        assertEq(
            settled.recipient,
            bytes32(uint256(uint160(intentReceiver))),
            "settlement must be addressed to the receiver"
        );
        assertEq(settled.recipientChain, 2, "wrong settlement chain");

        // The amount is the settlement's to state, so the instruction carries the destination and
        // the ceiling and nothing else.
        (uint64 instructionSequence, address forwardTo, uint256 ceiling) =
            abi.decode(coreBridge.lastPayload(), (uint64, address, uint256));

        assertEq(instructionSequence, sequence, "instruction must match the settlement");
        assertEq(forwardTo, depositAddress, "instruction must carry the deposit address");
        assertEq(ceiling, MAX_RELAY_FEE, "instruction must carry the fee ceiling");
        // The instruction names a rewindable counter, so it must not outlive the block that set it.
        assertEq(coreBridge.lastConsistency(), 202, "instruction must publish finalized");
    }

    /// @notice A ceiling at or above the delivery leaves the receiver nothing to forward, so a
    ///         colluding relayer could take the order whole.
    function testRelayFeeCeilingCannotSwallowTheDelivery() public {
        uint256 amountIn = 3 * TRIM_UNIT + DELIVERY_PRICE;
        weth.mint(user, amountIn);
        vm.deal(address(emitter), address(emitter).balance + amountIn);

        vm.startPrank(user);
        weth.approve(address(emitter), amountIn);
        vm.expectRevert(
            abi.encodeWithSelector(IIntentEmitter.RelayFeeExceedsAmount.selector, 3 * TRIM_UNIT, 3 * TRIM_UNIT)
        );
        emitter.placeOrder(HydrationConsts.WETH_ID, amountIn, 0, depositAddress, 3 * TRIM_UNIT);
        vm.stopPrank();
    }

    function testUnconfiguredReceiverReverts() public {
        vm.prank(emitter.owner());
        emitter.setIntentReceiver(address(0));

        vm.expectRevert(IIntentEmitter.NotConfigured.selector);
        emitter.placeOrder(HydrationConsts.WETH_ID, TRIM_UNIT, 0, depositAddress, MAX_RELAY_FEE);
    }

    function testZeroDepositAddressReverts() public {
        vm.prank(user);
        vm.expectRevert(IIntentEmitter.InvalidDepositAddress.selector);
        emitter.placeOrder(HydrationConsts.WETH_ID, TRIM_UNIT, 0, address(0), MAX_RELAY_FEE);
    }

    /// @notice An unbounded approve overflows Hydration's u128 erc20 precompile, so the approve must
    ///         be exact — and must not survive the call.
    function testApprovalIsExactAndNotLingering() public {
        _bridge(TRIM_UNIT + DELIVERY_PRICE, 0);
        assertEq(weth.allowance(address(emitter), address(nttManager)), 0, "stale approval left");
    }

    // ─── Fail-closed rail ───────────────────────────────────────────

    function testPausedRailReverts() public {
        nttManager.setPaused(true);

        weth.mint(user, TRIM_UNIT + DELIVERY_PRICE);
        vm.deal(address(emitter), TRIM_UNIT + DELIVERY_PRICE);

        vm.startPrank(user);
        weth.approve(address(emitter), TRIM_UNIT + DELIVERY_PRICE);
        vm.expectRevert(MockNttManager.TransferPaused.selector);
        emitter.placeOrder(HydrationConsts.WETH_ID, TRIM_UNIT + DELIVERY_PRICE, 0, depositAddress, MAX_RELAY_FEE);
        vm.stopPrank();

        assertEq(weth.balanceOf(user), TRIM_UNIT + DELIVERY_PRICE, "user keeps their funds");
    }

    /// @notice A rate-limit breach reverts rather than queues — the 3-arg overload hardcodes
    ///         shouldQueue=false, so no order can settle out of turn behind a live
    ///         authorization.
    function testCapacityBreachReverts() public {
        nttManager.setOutboundCapacity(TRIM_UNIT - 1);

        weth.mint(user, TRIM_UNIT + DELIVERY_PRICE);
        vm.deal(address(emitter), TRIM_UNIT + DELIVERY_PRICE);

        vm.startPrank(user);
        weth.approve(address(emitter), TRIM_UNIT + DELIVERY_PRICE);
        vm.expectRevert(
            abi.encodeWithSelector(MockNttManager.NotEnoughCapacity.selector, TRIM_UNIT - 1, TRIM_UNIT)
        );
        emitter.placeOrder(HydrationConsts.WETH_ID, TRIM_UNIT + DELIVERY_PRICE, 0, depositAddress, MAX_RELAY_FEE);
        vm.stopPrank();
    }

    // ─── Swap path ──────────────────────────────────────────────────

    function testSwapPathBridgesRouterOutput() public {
        uint64 sequence = _swapBridge(100e6, 5 * TRIM_UNIT + DELIVERY_PRICE, 5 * TRIM_UNIT);

        assertEq(nttManager.getTransfer(sequence).amount, 5 * TRIM_UNIT, "must bridge the swap output");
    }

    /// @notice The delta check binds even if the router ignores its own limit — otherwise a
    ///         short-filled swap bridges less than the caller accepted.
    function testInsufficientOutputReverts() public {
        dispatch.configure(address(weth), TRIM_UNIT + DELIVERY_PRICE);
        assetIn.mint(user, 100e6);

        vm.startPrank(user);
        assetIn.approve(address(emitter), 100e6);
        vm.expectRevert(IIntentEmitter.InsufficientOutput.selector);
        emitter.placeOrder(ASSET_IN, 100e6, 5 * TRIM_UNIT, depositAddress, MAX_RELAY_FEE);
        vm.stopPrank();
    }

    /// @notice Only this call's output may be bridged — WETH already resident (earlier dust,
    ///         donations) must not be swept into someone's order.
    function testStrayWethNotBridged() public {
        weth.mint(address(emitter), 9 * TRIM_UNIT);
        vm.deal(address(emitter), 9 * TRIM_UNIT);

        uint64 sequence = _swapBridge(100e6, TRIM_UNIT + DELIVERY_PRICE, 0);

        assertEq(
            nttManager.getTransfer(sequence).amount, TRIM_UNIT, "must bridge only this call's output"
        );
    }

    // ─── Guards ─────────────────────────────────────────────────────

    function testZeroAmountReverts() public {
        vm.prank(user);
        vm.expectRevert(IIntentEmitter.ZeroAmount.selector);
        emitter.placeOrder(HydrationConsts.WETH_ID, 0, 0, depositAddress, MAX_RELAY_FEE);
    }

    function testUnconfiguredReverts() public {
        IntentEmitter fresh = IntentEmitter(
            address(
                new ERC1967Proxy(
                    address(new IntentEmitter()),
                    abi.encodeCall(IntentEmitter.initialize, (address(coreBridge)))
                )
            )
        );

        vm.prank(user);
        vm.expectRevert(IIntentEmitter.NotConfigured.selector);
        fresh.placeOrder(HydrationConsts.WETH_ID, TRIM_UNIT, 0, depositAddress, MAX_RELAY_FEE);
    }

    /// @notice Wiring a manager for the wrong token would approve and burn something this contract
    ///         never swapped into.
    function testSetNttManagerRejectsForeignToken() public {
        MockERC20 other = new MockERC20();
        MockNttManager wrong = new MockNttManager(address(other));

        vm.expectRevert(
            abi.encodeWithSelector(
                IIntentEmitter.SettlementRouteMismatch.selector, address(weth), address(other)
            )
        );
        emitter.setNttManager(address(wrong));
    }

    function testAdminOnlyOwner() public {
        vm.startPrank(user);
        vm.expectRevert(IIntentEmitter.NotOwner.selector);
        emitter.setNttManager(address(nttManager));
        vm.expectRevert(IIntentEmitter.NotOwner.selector);
        emitter.sweep(address(weth), user, 1);
        vm.expectRevert(IIntentEmitter.NotOwner.selector);
        emitter.setOwner(user);
        vm.stopPrank();
    }
}
