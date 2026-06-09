// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {BasejumpLandingNative} from "../../src/basejump/BasejumpLandingNative.sol";
import {IBasejumpLandingNative} from "../../src/basejump/interfaces/IBasejumpLandingNative.sol";
import {IBasejumpReceiver} from "../../src/basejump/interfaces/IBasejumpReceiver.sol";

/// @dev Minimal ERC20 with mint
contract MockERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Receiver that records callback arguments. Payable so it can receive native ETH delivery.
contract MockReceiver is IBasejumpReceiver {
    address public lastAsset;
    uint256 public lastAmount;
    bytes public lastData;
    uint256 public callCount;
    bool public shouldRevert;
    string public revertReason = "receiver rejected";

    receive() external payable {}

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function onBasejumpReceive(address asset, uint256 amount, bytes calldata data) external {
        if (shouldRevert) revert(revertReason);
        lastAsset = asset;
        lastAmount = amount;
        lastData = data;
        callCount++;
    }
}

contract BasejumpLandingNativeTest is Test {
    BasejumpLandingNative public landing;
    MockERC20 public usdc;

    address public bridge = makeAddr("bridge");
    address public recipientAddr = makeAddr("recipient");
    bytes32 public recipient;
    address public stranger = makeAddr("stranger");

    /// @dev A fake source-chain asset address that maps to native ETH on this chain.
    address public srcEth = makeAddr("srcEth");
    address public NATIVE;

    uint256 constant POOL_AMOUNT = 100_000e6;

    function setUp() public {
        usdc = new MockERC20();
        recipient = bytes32(uint256(uint160(recipientAddr)));

        BasejumpLandingNative impl = new BasejumpLandingNative();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(BasejumpLandingNative.initialize, ())
        );
        landing = BasejumpLandingNative(payable(address(proxy)));
        NATIVE = landing.NATIVE();

        landing.setAuthorizedBridge(bridge, true);
        // Source→dest mappings: usdc pays out usdc; srcEth pays out native ETH.
        landing.setDestAsset(address(usdc), address(usdc));
        landing.setDestNative(srcEth);

        usdc.mint(address(landing), POOL_AMOUNT);
    }

    // ─── Deployment ──────────────────────────────────────────────

    function testDeployment() public view {
        assertEq(landing.owner(), address(this));
        assertTrue(landing.authorizedBridges(bridge));
        assertEq(landing.pendingHead(), 0);
        assertEq(landing.pendingTail(), 0);
        assertEq(landing.destAssetFor(address(usdc)), address(usdc));
        assertEq(landing.destAssetFor(srcEth), NATIVE);
        assertTrue(landing.isNative(srcEth));
        assertFalse(landing.isNative(address(usdc)));
    }

    function testSetDestNativeRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(IBasejumpLandingNative.NotOwner.selector);
        landing.setDestNative(srcEth);
    }

    function testCannotReinitialize() public {
        vm.expectRevert();
        landing.initialize();
    }

    // ─── Asset mapping ───────────────────────────────────────────

    function testTransferRevertsWhenAssetNotConfigured() public {
        address unknown = makeAddr("unknown");
        vm.prank(bridge);
        vm.expectRevert(abi.encodeWithSelector(IBasejumpLandingNative.AssetNotConfigured.selector, unknown));
        landing.transfer(unknown, 1_000e6, recipient, "");
    }

    // ─── Immediate delivery (EOA recipient, empty data) ──────────

    function testTransferDeliversToEoa() public {
        uint256 amount = 1_000e6;

        vm.expectEmit(true, true, true, true);
        emit IBasejumpLandingNative.TransferExecuted(address(usdc), address(usdc), recipient, amount);

        vm.prank(bridge);
        landing.transfer(address(usdc), amount, recipient, "");

        assertEq(usdc.balanceOf(recipientAddr), amount);
        assertEq(usdc.balanceOf(address(landing)), POOL_AMOUNT - amount);
        // No queue activity
        assertEq(landing.pendingHead(), 0);
        assertEq(landing.pendingTail(), 0);
    }

    function testTransferRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(IBasejumpLandingNative.NotAuthorizedBridge.selector);
        landing.transfer(address(usdc), 1_000e6, recipient, "");
    }

    // ─── Native ETH delivery ─────────────────────────────────────

    function testTransferDeliversNativeEthToEoa() public {
        uint256 amount = 3 ether;
        vm.deal(address(landing), 10 ether);
        uint256 before = recipientAddr.balance;

        vm.expectEmit(true, true, true, true);
        emit IBasejumpLandingNative.TransferExecuted(srcEth, NATIVE, recipient, amount);

        vm.prank(bridge);
        landing.transfer(srcEth, amount, recipient, "");

        assertEq(recipientAddr.balance, before + amount);
        assertEq(address(landing).balance, 10 ether - amount);
    }

    function testTransferQueuesNativeWhenInsufficientEth() public {
        uint256 amount = 5 ether;
        vm.deal(address(landing), 1 ether); // not enough

        vm.prank(bridge);
        landing.transfer(srcEth, amount, recipient, "");

        assertEq(landing.pendingTail(), 1);
        assertEq(recipientAddr.balance, 0);

        // Replenish and drain
        vm.deal(address(landing), amount);
        landing.fulfillPending();
        assertEq(recipientAddr.balance, amount);
        assertEq(landing.pendingHead(), 1);
    }

    function testTransferDeliversNativeEthWithCallback() public {
        MockReceiver receiver = new MockReceiver();
        bytes32 receiverBytes32 = bytes32(uint256(uint160(address(receiver))));
        bytes memory data = abi.encode(bytes32(uint256(0xdead)), makeAddr("depositAddress"));
        uint256 amount = 2 ether;
        vm.deal(address(landing), 10 ether);

        vm.prank(bridge);
        landing.transfer(srcEth, amount, receiverBytes32, data);

        assertEq(address(receiver).balance, amount);
        assertEq(receiver.callCount(), 1);
        assertEq(receiver.lastAsset(), NATIVE);
        assertEq(receiver.lastAmount(), amount);
        assertEq(receiver.lastData(), data);
    }

    // ─── Immediate delivery + receiver callback ──────────────────

    function testTransferInvokesReceiverWhenDataPresent() public {
        MockReceiver receiver = new MockReceiver();
        bytes32 receiverBytes32 = bytes32(uint256(uint160(address(receiver))));
        bytes memory data = abi.encode(bytes32(uint256(0xdead)), makeAddr("depositAddress"));

        uint256 amount = 2_500e6;

        vm.prank(bridge);
        landing.transfer(address(usdc), amount, receiverBytes32, data);

        assertEq(usdc.balanceOf(address(receiver)), amount);
        assertEq(receiver.callCount(), 1);
        assertEq(receiver.lastAsset(), address(usdc));
        assertEq(receiver.lastAmount(), amount);
        assertEq(receiver.lastData(), data);
    }

    function testReceiverRevertBubblesUp() public {
        MockReceiver receiver = new MockReceiver();
        receiver.setShouldRevert(true);
        bytes32 receiverBytes32 = bytes32(uint256(uint160(address(receiver))));

        vm.prank(bridge);
        vm.expectRevert("receiver rejected");
        landing.transfer(address(usdc), 1_000e6, receiverBytes32, hex"01");
    }

    function testTransferRevertsWhenDataPresentButRecipientIsEoa() public {
        vm.prank(bridge);
        vm.expectRevert(
            abi.encodeWithSelector(IBasejumpLandingNative.ReceiverNotContract.selector, recipientAddr)
        );
        landing.transfer(address(usdc), 1_000e6, recipient, hex"deadbeef");
    }

    function testEmptyDataSkipsCallbackOnContractRecipient() public {
        MockReceiver receiver = new MockReceiver();
        bytes32 receiverBytes32 = bytes32(uint256(uint160(address(receiver))));

        vm.prank(bridge);
        landing.transfer(address(usdc), 1_000e6, receiverBytes32, "");

        assertEq(receiver.callCount(), 0);
        assertEq(usdc.balanceOf(address(receiver)), 1_000e6);
    }

    // ─── Queue path (insufficient liquidity) ─────────────────────

    function testTransferQueuesWhenInsufficientBalance() public {
        uint256 over = POOL_AMOUNT + 1e6;

        vm.expectEmit(true, true, false, true);
        emit IBasejumpLandingNative.TransferQueued(0, address(usdc), address(usdc), recipient, over);

        vm.prank(bridge);
        landing.transfer(address(usdc), over, recipient, "");

        // Pool untouched
        assertEq(usdc.balanceOf(address(landing)), POOL_AMOUNT);
        assertEq(usdc.balanceOf(recipientAddr), 0);

        // Pending stored
        (address asset, uint256 amount, bytes32 rec, bytes memory data) = landing.pendingTransfers(0);
        assertEq(asset, address(usdc));
        assertEq(amount, over);
        assertEq(rec, recipient);
        assertEq(data.length, 0);

        assertEq(landing.pendingTail(), 1);
        assertEq(landing.pendingHead(), 0);
    }

    function testTransferQueuesPreservesData() public {
        MockReceiver receiver = new MockReceiver();
        bytes32 receiverBytes32 = bytes32(uint256(uint160(address(receiver))));
        bytes memory payload = abi.encode(bytes32(uint256(0xbeef)), makeAddr("depositAddress"));

        uint256 over = POOL_AMOUNT + 1e6;

        vm.prank(bridge);
        landing.transfer(address(usdc), over, receiverBytes32, payload);

        (,,, bytes memory data) = landing.pendingTransfers(0);
        assertEq(data, payload);
        // Receiver not yet invoked
        assertEq(receiver.callCount(), 0);
    }

    function testQueueStillValidatesReceiverShapeUpfront() public {
        // EOA recipient with non-empty data must revert even when liquidity is insufficient,
        // before anything gets queued.
        uint256 over = POOL_AMOUNT + 1e6;

        vm.prank(bridge);
        vm.expectRevert(
            abi.encodeWithSelector(IBasejumpLandingNative.ReceiverNotContract.selector, recipientAddr)
        );
        landing.transfer(address(usdc), over, recipient, hex"deadbeef");

        assertEq(landing.pendingTail(), 0);
    }

    // ─── fulfillPending ──────────────────────────────────────────

    function testFulfillPendingDeliversPlainTransfer() public {
        uint256 over = POOL_AMOUNT + 1e6;

        vm.prank(bridge);
        landing.transfer(address(usdc), over, recipient, "");

        // Replenish pool (simulates slow settlement)
        usdc.mint(address(landing), 10e6);

        vm.expectEmit(true, true, false, true);
        emit IBasejumpLandingNative.PendingTransferFulfilled(0, address(usdc), address(usdc), recipient, over);

        landing.fulfillPending();

        assertEq(usdc.balanceOf(recipientAddr), over);
        // Entry cleared
        (address asset,,,) = landing.pendingTransfers(0);
        assertEq(asset, address(0));
        assertEq(landing.pendingHead(), 1);
    }

    function testFulfillPendingInvokesReceiverCallback() public {
        MockReceiver receiver = new MockReceiver();
        bytes32 receiverBytes32 = bytes32(uint256(uint160(address(receiver))));
        bytes memory payload = abi.encode(bytes32(uint256(0xbeef)), makeAddr("depositAddress"));

        uint256 over = POOL_AMOUNT + 5e6;

        vm.prank(bridge);
        landing.transfer(address(usdc), over, receiverBytes32, payload);

        // Receiver hasn't been called at queue time
        assertEq(receiver.callCount(), 0);

        // Replenish so the drain can succeed
        usdc.mint(address(landing), 10e6);

        landing.fulfillPending();

        // Callback fires at drain time with full payload preserved
        assertEq(receiver.callCount(), 1);
        assertEq(receiver.lastAsset(), address(usdc));
        assertEq(receiver.lastAmount(), over);
        assertEq(receiver.lastData(), payload);
        assertEq(landing.pendingHead(), 1);
    }

    function testFulfillPendingRevertsNoPending() public {
        vm.expectRevert(IBasejumpLandingNative.NoPendingTransfers.selector);
        landing.fulfillPending();
    }

    function testFulfillPendingRevertsInsufficientBalance() public {
        uint256 over = POOL_AMOUNT + 1e6;

        vm.prank(bridge);
        landing.transfer(address(usdc), over, recipient, "");

        // Don't replenish — drain still impossible
        vm.expectRevert(IBasejumpLandingNative.InsufficientBalance.selector);
        landing.fulfillPending();
    }

    function testFulfillPendingReceiverRevertLeavesEntryDoesNotConsume() public {
        // A receiver-reverting drain must not advance the head pointer or burn the entry.
        MockReceiver receiver = new MockReceiver();
        receiver.setShouldRevert(true);
        bytes32 receiverBytes32 = bytes32(uint256(uint160(address(receiver))));

        uint256 over = POOL_AMOUNT + 1e6;

        vm.prank(bridge);
        landing.transfer(address(usdc), over, receiverBytes32, hex"deadbeef");

        usdc.mint(address(landing), 10e6);

        vm.expectRevert("receiver rejected");
        landing.fulfillPending();

        // Head pointer still 0, entry still present, pool not drained
        assertEq(landing.pendingHead(), 0);
        (address asset,,,) = landing.pendingTransfers(0);
        assertEq(asset, address(usdc));
        assertEq(usdc.balanceOf(address(receiver)), 0);
    }

    function testFulfillPendingFifo() public {
        vm.startPrank(bridge);
        landing.transfer(address(usdc), POOL_AMOUNT + 1, recipient, "");
        landing.transfer(address(usdc), POOL_AMOUNT + 2, recipient, "");
        landing.transfer(address(usdc), POOL_AMOUNT + 3, recipient, "");
        vm.stopPrank();

        assertEq(landing.pendingTail(), 3);

        // Plenty of liquidity now
        usdc.mint(address(landing), POOL_AMOUNT * 3);

        landing.fulfillPending(); // id 0
        landing.fulfillPending(); // id 1
        landing.fulfillPending(); // id 2

        assertEq(landing.pendingHead(), 3);
    }

    // ─── Admin ───────────────────────────────────────────────────

    function testWithdraw() public {
        address dest = makeAddr("dest");
        landing.withdraw(address(usdc), 5_000e6, dest);
        assertEq(usdc.balanceOf(dest), 5_000e6);
    }

    function testWithdrawNative() public {
        vm.deal(address(landing), 4 ether);
        address dest = makeAddr("dest");
        landing.withdraw(NATIVE, 1 ether, dest);
        assertEq(dest.balance, 1 ether);
        assertEq(address(landing).balance, 3 ether);
    }

    function testWithdrawRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(IBasejumpLandingNative.NotOwner.selector);
        landing.withdraw(address(usdc), 1, stranger);
    }

    function testSetDestAssetRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(IBasejumpLandingNative.NotOwner.selector);
        landing.setDestAsset(srcEth, NATIVE);
    }

    function testSetOwner() public {
        address newOwner = makeAddr("newOwner");
        landing.setOwner(newOwner);
        assertEq(landing.owner(), newOwner);
    }
}
