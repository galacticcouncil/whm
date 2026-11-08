// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {BasejumpLanding} from "../../src/basejump/BasejumpLanding.sol";
import {IBasejumpLanding} from "../../src/basejump/interfaces/IBasejumpLanding.sol";
import {ScaleCodec} from "../../src/utils/ScaleCodec.sol";

/// @dev Minimal ERC20 with mint
contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Stands in for the 0x0401 dispatch precompile when a test needs it to depend on the gas it
///      is given: fails (without burning the rest) below 200k gas, succeeds at or above it.
contract GasHungryDispatch {
    fallback() external {
        if (gasleft() < 200_000) revert("out of gas");
    }
}

/// @dev Succeeds only when it received (nearly) the whole 500k PARK_DISPATCH_GAS stipend.
contract NeedsFullStipend {
    fallback() external {
        if (gasleft() < 499_900) revert("out of gas");
    }
}

contract BasejumpLandingTest is Test {
    BasejumpLanding public basejumpLanding;
    MockERC20 public usdc;
    MockERC20 public sourceUsdc;

    address public bridge = makeAddr("bridge");
    address public recipientAddr = makeAddr("recipient");
    bytes32 public recipient;
    address public stranger = makeAddr("stranger");

    // Dispatch precompile address
    address constant DISPATCH_PRECOMPILE = 0x0000000000000000000000000000000000000401;

    uint256 constant POOL_AMOUNT = 100_000e6;

    function setUp() public {
        usdc = new MockERC20();
        sourceUsdc = new MockERC20();

        // Convert address to bytes32 (right-padded, so we put address in low bits)
        recipient = bytes32(uint256(uint160(recipientAddr)));

        BasejumpLanding impl = new BasejumpLanding();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(BasejumpLanding.initialize, ())
        );
        basejumpLanding = BasejumpLanding(address(proxy));

        basejumpLanding.setAuthorizedBridge(bridge, true);
        basejumpLanding.setDestAsset(address(sourceUsdc), address(usdc));

        usdc.mint(address(basejumpLanding), POOL_AMOUNT);

        // Mock the dispatch precompile to succeed (empty return = success)
        vm.mockCall(DISPATCH_PRECOMPILE, bytes(""), bytes(""));
    }

    // ─── Deployment ──────────────────────────────────────────────

    function testDeployment() public view {
        assertEq(basejumpLanding.owner(), address(this));
        assertEq(basejumpLanding.authorizedBridges(bridge), true);
        assertEq(basejumpLanding.DISPATCH(), DISPATCH_PRECOMPILE);
        assertEq(basejumpLanding.CURRENCIES_PALLET_INDEX(), 79);
        assertEq(basejumpLanding.CURRENCIES_TRANSFER_INDEX(), 0);
    }

    function testCannotReinitialize() public {
        vm.expectRevert();
        basejumpLanding.initialize();
    }

    // ─── Transfer ──────────────────────────────────────────────

    function testTransfer() public {
        uint256 amount = 1_000e6;

        vm.prank(bridge);
        basejumpLanding.transfer(address(sourceUsdc), amount, recipient, "");

        // Pool balance reduced (used for balance check)
        assertEq(usdc.balanceOf(address(basejumpLanding)), POOL_AMOUNT);
    }

    function testTransferEmitsEvent() public {
        uint256 amount = 1_000e6;

        vm.expectEmit(true, true, true, true);
        emit IBasejumpLanding.TransferExecuted(address(sourceUsdc), address(usdc), recipient, amount);

        vm.prank(bridge);
        basejumpLanding.transfer(address(sourceUsdc), amount, recipient, "");
    }

    function testTransferCallsDispatch() public {
        uint256 amount = 1_000e6;

        // Expect a call to dispatch precompile (any calldata)
        vm.expectCall(DISPATCH_PRECOMPILE, bytes(""));

        vm.prank(bridge);
        basejumpLanding.transfer(address(sourceUsdc), amount, recipient, "");
    }

    function testTransferRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(IBasejumpLanding.NotAuthorizedBridge.selector);
        basejumpLanding.transfer(address(sourceUsdc), 1_000e6, recipient, "");
    }

    function testTransferRevertsAssetNotConfigured() public {
        address unconfiguredSource = makeAddr("unconfiguredSource");

        vm.prank(bridge);
        vm.expectRevert(abi.encodeWithSelector(IBasejumpLanding.AssetNotConfigured.selector, unconfiguredSource));
        basejumpLanding.transfer(unconfiguredSource, 1_000e6, recipient, "");
    }

    function testTransferRevertsOnDispatchFailure() public {
        // Clear the mock and make dispatch revert
        vm.mockCallRevert(DISPATCH_PRECOMPILE, bytes(""), bytes("dispatch failed"));

        vm.prank(bridge);
        vm.expectRevert(IBasejumpLanding.DispatchFailed.selector);
        basejumpLanding.transfer(address(sourceUsdc), 1_000e6, recipient, "");
    }

    function testTransferQueuesWhenInsufficientBalance() public {
        uint256 overAmount = POOL_AMOUNT + 1e6;

        vm.expectEmit(true, true, true, true);
        emit IBasejumpLanding.TransferQueued(0, address(sourceUsdc), address(usdc), recipient, overAmount);

        vm.prank(bridge);
        basejumpLanding.transfer(address(sourceUsdc), overAmount, recipient, "");

        // Pool untouched
        assertEq(usdc.balanceOf(address(basejumpLanding)), POOL_AMOUNT);
        // Pending transfer stored
        (address srcAsset, uint256 amount, bytes32 rec) = basejumpLanding.pendingTransfers(0);
        assertEq(srcAsset, address(sourceUsdc));
        assertEq(amount, overAmount);
        assertEq(rec, recipient);
        assertEq(basejumpLanding.pendingTail(), 1);
        assertEq(basejumpLanding.pendingHead(), 0);
    }

    // ─── Pending Transfers ────────────────────────────────────────

    function testFulfillPending() public {
        uint256 overAmount = POOL_AMOUNT + 1e6;

        // Queue a transfer
        vm.prank(bridge);
        basejumpLanding.transfer(address(sourceUsdc), overAmount, recipient, "");

        // Replenish the pool (simulates slow bridge settlement)
        usdc.mint(address(basejumpLanding), 10e6);

        // Fulfill
        vm.expectEmit(true, true, true, true);
        emit IBasejumpLanding.PendingTransferFulfilled(0, address(sourceUsdc), address(usdc), recipient, overAmount);

        basejumpLanding.fulfillPending();

        // Pending transfer deleted, head advanced
        (address srcAsset,,) = basejumpLanding.pendingTransfers(0);
        assertEq(srcAsset, address(0));
        assertEq(basejumpLanding.pendingHead(), 1);
    }

    function testFulfillPendingCallsDispatch() public {
        uint256 overAmount = POOL_AMOUNT + 1e6;

        vm.prank(bridge);
        basejumpLanding.transfer(address(sourceUsdc), overAmount, recipient, "");

        usdc.mint(address(basejumpLanding), 10e6);

        // Expect a call to dispatch precompile (any calldata)
        vm.expectCall(DISPATCH_PRECOMPILE, bytes(""));

        basejumpLanding.fulfillPending();
    }

    function testFulfillPendingRevertsNoPending() public {
        vm.expectRevert(IBasejumpLanding.NoPendingTransfers.selector);
        basejumpLanding.fulfillPending();
    }

    function testFulfillPendingRevertsInsufficientBalance() public {
        uint256 overAmount = POOL_AMOUNT + 1e6;

        vm.prank(bridge);
        basejumpLanding.transfer(address(sourceUsdc), overAmount, recipient, "");

        // Don't replenish — should revert
        vm.expectRevert(IBasejumpLanding.InsufficientBalance.selector);
        basejumpLanding.fulfillPending();
    }

    function testFulfillPendingCannotDoubleFulfill() public {
        uint256 overAmount = POOL_AMOUNT + 1e6;

        vm.prank(bridge);
        basejumpLanding.transfer(address(sourceUsdc), overAmount, recipient, "");

        usdc.mint(address(basejumpLanding), 10e6);
        basejumpLanding.fulfillPending();

        // Second attempt — queue is empty
        vm.expectRevert(IBasejumpLanding.NoPendingTransfers.selector);
        basejumpLanding.fulfillPending();
    }

    function testMultiplePendingTransfers() public {
        // Queue three transfers that all exceed the pool
        vm.startPrank(bridge);
        basejumpLanding.transfer(address(sourceUsdc), POOL_AMOUNT + 1, recipient, "");
        basejumpLanding.transfer(address(sourceUsdc), POOL_AMOUNT + 5_000e6, recipient, "");
        basejumpLanding.transfer(address(sourceUsdc), POOL_AMOUNT + 3_000e6, recipient, "");
        vm.stopPrank();

        assertEq(basejumpLanding.pendingTail(), 3);
        assertEq(basejumpLanding.pendingHead(), 0);

        // Replenish and fulfill all (FIFO order)
        usdc.mint(address(basejumpLanding), POOL_AMOUNT * 3 + 10_000e6);
        basejumpLanding.fulfillPending(); // fulfills id 0
        basejumpLanding.fulfillPending(); // fulfills id 1
        basejumpLanding.fulfillPending(); // fulfills id 2

        // All pending transfers deleted, head caught up to tail
        assertEq(basejumpLanding.pendingHead(), 3);
        (address srcAsset0,,) = basejumpLanding.pendingTransfers(0);
        (address srcAsset1,,) = basejumpLanding.pendingTransfers(1);
        (address srcAsset2,,) = basejumpLanding.pendingTransfers(2);
        assertEq(srcAsset0, address(0));
        assertEq(srcAsset1, address(0));
        assertEq(srcAsset2, address(0));
    }

    // ─── Admin ───────────────────────────────────────────────────

    function testWithdraw() public {
        address dest = makeAddr("dest");
        basejumpLanding.withdraw(address(usdc), 50_000e6, dest);
        assertEq(usdc.balanceOf(dest), 50_000e6);
    }

    function testWithdrawEmitsEvent() public {
        address dest = makeAddr("dest");

        vm.expectEmit(true, true, false, true);
        emit IBasejumpLanding.Withdrawn(address(usdc), 50_000e6, dest);

        basejumpLanding.withdraw(address(usdc), 50_000e6, dest);
    }

    function testWithdrawRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(IBasejumpLanding.NotOwner.selector);
        basejumpLanding.withdraw(address(usdc), 1, stranger);
    }

    function testSetAuthorizedBridge() public {
        address newBridge = makeAddr("newBridge");
        basejumpLanding.setAuthorizedBridge(newBridge, true);
        assertEq(basejumpLanding.authorizedBridges(newBridge), true);

        basejumpLanding.setAuthorizedBridge(newBridge, false);
        assertEq(basejumpLanding.authorizedBridges(newBridge), false);
    }

    function testSetAuthorizedBridgeRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(IBasejumpLanding.NotOwner.selector);
        basejumpLanding.setAuthorizedBridge(bridge, false);
    }

    function testSetOwner() public {
        address newOwner = makeAddr("newOwner");
        basejumpLanding.setOwner(newOwner);
        assertEq(basejumpLanding.owner(), newOwner);
    }

    function testSetOwnerRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(IBasejumpLanding.NotOwner.selector);
        basejumpLanding.setOwner(stranger);
    }

    // ─── Dest Asset Configuration ────────────────────────────────────

    function testSetDestAsset() public {
        address newSource = makeAddr("newSource");
        address newDest = makeAddr("newDest");

        assertEq(basejumpLanding.destAssetFor(newSource), address(0));

        vm.expectEmit(true, true, false, true);
        emit IBasejumpLanding.DestAssetUpdated(newSource, newDest);

        basejumpLanding.setDestAsset(newSource, newDest);
        assertEq(basejumpLanding.destAssetFor(newSource), newDest);

        // Can clear by setting to address(0)
        basejumpLanding.setDestAsset(newSource, address(0));
        assertEq(basejumpLanding.destAssetFor(newSource), address(0));
    }

    function testSetDestAssetRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(IBasejumpLanding.NotOwner.selector);
        basejumpLanding.setDestAsset(address(sourceUsdc), address(usdc));
    }

    function testTransferAfterDestAssetCleared() public {
        // Clear the dest asset
        basejumpLanding.setDestAsset(address(sourceUsdc), address(0));

        // Transfer should now revert
        vm.prank(bridge);
        vm.expectRevert(abi.encodeWithSelector(IBasejumpLanding.AssetNotConfigured.selector, address(sourceUsdc)));
        basejumpLanding.transfer(address(sourceUsdc), 1_000e6, recipient, "");
    }

    // ─── AccountId32 Recipient ────────────────────────────────────

    function testTransferWithAccountId32() public {
        // A typical Polkadot AccountId32 (not a valid EVM address)
        bytes32 polkadotRecipient = bytes32(0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef);

        uint256 amount = 1_000e6;

        vm.expectEmit(true, true, true, true);
        emit IBasejumpLanding.TransferExecuted(address(sourceUsdc), address(usdc), polkadotRecipient, amount);

        vm.prank(bridge);
        basejumpLanding.transfer(address(sourceUsdc), amount, polkadotRecipient, "");
    }

    // ─── FIFO priority ───────────────────────────────────────────

    /// @dev The encoded currencies.transfer the landing dispatches for (asset, recipient, amount).
    function _dispatchCall(address asset, bytes32 to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(79), uint8(0), to, ScaleCodec.u32Le(uint32(uint160(asset))), ScaleCodec.compactU128(uint128(amount))
        );
    }

    /// @dev Queue one transfer of POOL_AMOUNT + 1e6 (the pool holds POOL_AMOUNT), as id 0.
    function _queueHead() internal returns (uint256 headAmount) {
        headAmount = POOL_AMOUNT + 1e6;
        vm.prank(bridge);
        basejumpLanding.transfer(address(sourceUsdc), headAmount, recipient, "");
        assertEq(basejumpLanding.pendingTail(), 1, "head must queue");
    }

    /// @notice A newer payout must not spend liquidity the queued head is waiting for.
    function testNewerTransferCannotTakeLiquidityReservedForHead() public {
        uint256 headAmount = _queueHead();
        assertEq(basejumpLanding.reservedFor(address(usdc)), headAmount);

        // Settlement tops the pool up to exactly the head's amount.
        usdc.mint(address(basejumpLanding), headAmount - POOL_AMOUNT);

        // A newer, small payout arrives first. The balance would cover it, but only by spending
        // what the head is owed, so it must queue behind the head and dispatch nothing.
        bytes32 newer = bytes32(uint256(0xBEEF));
        vm.mockCallRevert(DISPATCH_PRECOMPILE, _dispatchCall(address(usdc), newer, 1_000e6), bytes("newer paid first"));
        vm.expectEmit(true, true, true, true);
        emit IBasejumpLanding.TransferQueued(1, address(sourceUsdc), address(usdc), newer, 1_000e6);
        vm.prank(bridge);
        basejumpLanding.transfer(address(sourceUsdc), 1_000e6, newer, "");

        assertEq(basejumpLanding.pendingTail(), 2, "newer payout must queue");
        assertEq(basejumpLanding.reservedFor(address(usdc)), headAmount + 1_000e6);

        // The head is paid first and releases its reservation.
        vm.expectEmit(true, true, true, true);
        emit IBasejumpLanding.PendingTransferFulfilled(0, address(sourceUsdc), address(usdc), recipient, headAmount);
        basejumpLanding.fulfillPending();
        assertEq(basejumpLanding.reservedFor(address(usdc)), 1_000e6);
        assertEq(basejumpLanding.reservedAssetOf(0), address(0));
    }

    /// @notice The rule is "balance covers the reservation plus this amount", not "queue empty":
    ///         a pool with liquidity beyond everything queued still pays newcomers directly.
    function testTransferPaysDirectlyAboveReservation() public {
        uint256 headAmount = _queueHead();
        usdc.mint(address(basejumpLanding), headAmount + 1_000e6 - POOL_AMOUNT);

        vm.expectEmit(true, true, true, true);
        emit IBasejumpLanding.TransferExecuted(address(sourceUsdc), address(usdc), recipient, 1_000e6);
        vm.prank(bridge);
        basejumpLanding.transfer(address(sourceUsdc), 1_000e6, recipient, "");

        assertEq(basejumpLanding.pendingTail(), 1, "covered payout must not queue");
        assertEq(basejumpLanding.reservedFor(address(usdc)), headAmount);
    }

    /// @notice The landing is shared across corridors: a shortfall in one asset must not make
    ///         another asset's payouts queue (a global "queue empty" rule would).
    function testOtherAssetPaysDirectlyWhileQueueHolds() public {
        _queueHead();

        MockERC20 eurc = new MockERC20();
        MockERC20 sourceEurc = new MockERC20();
        basejumpLanding.setDestAsset(address(sourceEurc), address(eurc));
        eurc.mint(address(basejumpLanding), 10_000e6);

        vm.expectEmit(true, true, true, true);
        emit IBasejumpLanding.TransferExecuted(address(sourceEurc), address(eurc), recipient, 500e6);
        vm.prank(bridge);
        basejumpLanding.transfer(address(sourceEurc), 500e6, recipient, "");

        assertEq(basejumpLanding.pendingTail(), 1, "EURC payout must not queue behind a USDC head");
        assertEq(basejumpLanding.reservedFor(address(eurc)), 0);
    }

    /// @notice Now checked before the queue branch too: a queued amount above u128 could never be paid.
    function testTransferRevertsAmountTooLarge() public {
        uint256 tooLarge = uint256(type(uint128).max) + 1;
        vm.prank(bridge);
        vm.expectRevert(bytes("Amount exceeds uint128"));
        basejumpLanding.transfer(address(sourceUsdc), tooLarge, recipient, "");
    }

    // ─── Unpayable head: park and recover ────────────────────────

    /// @dev Drain the pool to `left`, then queue a 1-unit payout to `dust` (refused by the runtime)
    ///      as id 0 and a normal payout as id 1.
    function _queueDustHeadThenNormal(bytes32 dust) internal returns (uint256 normalAmount) {
        basejumpLanding.withdraw(address(usdc), POOL_AMOUNT, makeAddr("sink"));
        vm.mockCallRevert(
            DISPATCH_PRECOMPILE, _dispatchCall(address(usdc), dust, 1), bytes("dispatch execution failed: ExistentialDeposit")
        );

        normalAmount = 1_000e6;
        vm.startPrank(bridge);
        basejumpLanding.transfer(address(sourceUsdc), 1, dust, "");
        basejumpLanding.transfer(address(sourceUsdc), normalAmount, recipient, "");
        vm.stopPrank();
        assertEq(basejumpLanding.pendingTail(), 2);

        usdc.mint(address(basejumpLanding), normalAmount + 1);
    }

    /// @notice A sub-minimum head blocks fulfillPending forever; parkPending moves it aside and the
    ///         next payout is reached.
    function testSubMinimumHeadCannotBlockLaterPayouts() public {
        bytes32 dust = bytes32(uint256(0xD057));
        uint256 normalAmount = _queueDustHeadThenNormal(dust);

        // The stuck state: the pool can fund the head, the runtime refuses it.
        vm.expectRevert(IBasejumpLanding.DispatchFailed.selector);
        basejumpLanding.fulfillPending();

        vm.expectEmit(true, true, true, true);
        emit IBasejumpLanding.TransferParked(0, address(sourceUsdc), address(usdc), dust, 1);
        vm.prank(stranger);
        basejumpLanding.parkPending();

        assertEq(basejumpLanding.pendingHead(), 1, "head must advance past the parked entry");
        (address parkedSrc, uint256 parkedAmount, bytes32 parkedTo) = basejumpLanding.parkedTransfers(0);
        assertEq(parkedSrc, address(sourceUsdc));
        assertEq(parkedAmount, 1);
        assertEq(parkedTo, dust);
        assertEq(basejumpLanding.reservedFor(address(usdc)), 1 + normalAmount, "parked amount stays reserved");

        // The later payout is reached.
        vm.expectEmit(true, true, true, true);
        emit IBasejumpLanding.PendingTransferFulfilled(1, address(sourceUsdc), address(usdc), recipient, normalAmount);
        basejumpLanding.fulfillPending();
        assertEq(basejumpLanding.pendingHead(), 2);
        assertEq(basejumpLanding.reservedFor(address(usdc)), 1);
    }

    /// @notice A parked entry is paid once its dispatch can succeed; until then it stays parked.
    function testParkedEntryIsRecoverable() public {
        bytes32 dust = bytes32(uint256(0xD057));
        _queueDustHeadThenNormal(dust);
        basejumpLanding.parkPending();

        // Still refused: the entry stays parked.
        vm.expectRevert(IBasejumpLanding.DispatchFailed.selector);
        basejumpLanding.fulfillParked(0);
        (address stillParked,,) = basejumpLanding.parkedTransfers(0);
        assertEq(stillParked, address(sourceUsdc));

        // The recipient becomes payable (e.g. its account now exists).
        vm.clearMockedCalls();
        vm.mockCall(DISPATCH_PRECOMPILE, bytes(""), bytes(""));

        vm.expectEmit(true, true, true, true);
        emit IBasejumpLanding.ParkedTransferFulfilled(0, address(sourceUsdc), address(usdc), dust, 1);
        vm.prank(stranger);
        basejumpLanding.fulfillParked(0);

        (address cleared,,) = basejumpLanding.parkedTransfers(0);
        assertEq(cleared, address(0));
        assertEq(basejumpLanding.reservedAssetOf(0), address(0));

        vm.expectRevert(abi.encodeWithSelector(IBasejumpLanding.NotParked.selector, 0));
        basejumpLanding.fulfillParked(0);
    }

    /// @notice parkPending on a payable head pays it, exactly as fulfillPending would.
    function testParkPendingPaysPayableHead() public {
        uint256 headAmount = _queueHead();
        usdc.mint(address(basejumpLanding), headAmount - POOL_AMOUNT);

        vm.expectEmit(true, true, true, true);
        emit IBasejumpLanding.PendingTransferFulfilled(0, address(sourceUsdc), address(usdc), recipient, headAmount);
        basejumpLanding.parkPending();

        (address parked,,) = basejumpLanding.parkedTransfers(0);
        assertEq(parked, address(0), "a payable head must not be parked");
        assertEq(basejumpLanding.reservedFor(address(usdc)), 0);
    }

    /// @notice An unfunded head is never skipped: parking needs the pool to hold its amount.
    function testParkPendingRevertsWhenUnfunded() public {
        _queueHead();
        vm.mockCallRevert(DISPATCH_PRECOMPILE, bytes(""), bytes("would fail"));

        vm.expectRevert(IBasejumpLanding.InsufficientBalance.selector);
        basejumpLanding.parkPending();
        assertEq(basejumpLanding.pendingHead(), 0);
    }

    /// @notice The caller's gas limit cannot make a payable head's dispatch fail and park it.
    function testParkPendingRevertsOnLowGas() public {
        uint256 headAmount = _queueHead();
        usdc.mint(address(basejumpLanding), headAmount - POOL_AMOUNT);

        vm.clearMockedCalls();
        vm.etch(DISPATCH_PRECOMPILE, address(new GasHungryDispatch()).code);

        // 300k reaches parkPending: enough to park, too little to forward the stipend.
        (bool ok, bytes memory ret) = address(basejumpLanding).call{gas: 300_000}(abi.encodeCall(BasejumpLanding.parkPending, ()));
        assertFalse(ok, "low-gas parkPending must revert");
        assertEq(bytes4(ret), IBasejumpLanding.InsufficientGas.selector);
        assertEq(basejumpLanding.pendingHead(), 0);
        (address parked,,) = basejumpLanding.parkedTransfers(0);
        assertEq(parked, address(0));

        // With enough gas the same head is paid.
        basejumpLanding.parkPending();
        assertEq(basejumpLanding.pendingHead(), 1);
        (parked,,) = basejumpLanding.parkedTransfers(0);
        assertEq(parked, address(0), "a payable head must be paid, not parked");
    }

    function testParkPendingRevertsNoPending() public {
        vm.expectRevert(IBasejumpLanding.NoPendingTransfers.selector);
        basejumpLanding.parkPending();
    }

    /// @dev One `parkPending` attempt at caller gas `g`, state rolled back. Returns
    ///      (insufficientGas revert, parked, paid).
    function _parkAt(uint256 g) internal returns (bool lowGas, bool parked, bool paid) {
        uint256 snap = vm.snapshotState();
        (bool ok, bytes memory ret) = address(basejumpLanding).call{gas: g}(abi.encodeCall(BasejumpLanding.parkPending, ()));
        (address p,,) = basejumpLanding.parkedTransfers(0);
        lowGas = !ok && ret.length >= 4 && bytes4(ret) == IBasejumpLanding.InsufficientGas.selector;
        parked = p != address(0);
        paid = ok && !parked && basejumpLanding.pendingHead() == 1;
        vm.revertToState(snap);
    }

    /// @dev Queue a payable head behind a dispatch that needs the full stipend, then locate the
    ///      threshold: the smallest caller gas that does not revert InsufficientGas.
    function _locateParkThreshold() internal returns (uint256 threshold) {
        uint256 headAmount = _queueHead();
        usdc.mint(address(basejumpLanding), headAmount - POOL_AMOUNT);
        vm.clearMockedCalls();
        vm.etch(DISPATCH_PRECOMPILE, address(new NeedsFullStipend()).code);

        uint256 lo = 300_000; // below the stipend: always InsufficientGas
        uint256 hi = 3_000_000; // ample: never InsufficientGas
        (bool loLow,,) = _parkAt(lo);
        (bool hiLow,,) = _parkAt(hi);
        assertTrue(loLow && !hiLow, "threshold not bracketed");
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            (bool midLow,,) = _parkAt(mid);
            if (midLow) lo = mid;
            else hi = mid;
        }
        threshold = hi;
    }

    /// @dev Sweep [from, to) at step 5; returns (InsufficientGas reverts, parked, paid).
    function _sweepPark(uint256 from, uint256 to) internal returns (uint256 lowGas, uint256 parked, uint256 paid) {
        for (uint256 g = from; g < to; g += 5) {
            (bool l, bool pk, bool pd) = _parkAt(g);
            if (l) lowGas++;
            if (pk) parked++;
            if (pd) paid++;
        }
    }

    /// @notice EIP-150 boundary, located rather than hard-coded: from 20k caller gas below the
    ///         InsufficientGas threshold up to it, a payable head is never parked and the window
    ///         holds an InsufficientGas revert. Split from the upper half to fit the test gas limit.
    function testParkPendingGasSweepBelowThresholdNeverParks() public {
        uint256 threshold = _locateParkThreshold();
        (uint256 lowGas, uint256 parked,) = _sweepPark(threshold - 20_000, threshold);
        assertGt(lowGas, 0, "window holds no InsufficientGas revert");
        assertEq(parked, 0, "a payable head was parked for some caller gas limit");
    }

    /// @notice From the located threshold up to 20k above it, a payable head whose dispatch needs
    ///         the full stipend is paid, never parked. Pins the `PARK_DISPATCH_GAS / 63 + 10_000`
    ///         margin, not only the check: without it the band just above the threshold parks.
    function testParkPendingGasSweepAboveThresholdNeverParks() public {
        uint256 threshold = _locateParkThreshold();
        (, uint256 parked, uint256 paid) = _sweepPark(threshold, threshold + 20_000);
        assertGt(paid, 0, "window holds no payment");
        assertEq(parked, 0, "a payable head was parked for some caller gas limit");
    }
}
