// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {BasejumpLandingEvm} from "../../src/basejump/BasejumpLandingEvm.sol";
import {IBasejumpLandingEvm} from "../../src/basejump/interfaces/IBasejumpLandingEvm.sol";
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

/// @dev Receiver that records callback arguments.
contract MockReceiver is IBasejumpReceiver {
    address public lastAsset;
    uint256 public lastAmount;
    bytes public lastData;
    uint256 public callCount;
    bool public shouldRevert;
    string public revertReason = "receiver rejected";

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

contract BasejumpLandingEvmTest is Test {
    BasejumpLandingEvm public landing;
    MockERC20 public usdc;

    address public bridge = makeAddr("bridge");
    address public recipientAddr = makeAddr("recipient");
    bytes32 public recipient;
    address public stranger = makeAddr("stranger");

    uint256 constant POOL_AMOUNT = 100_000e6;

    function setUp() public {
        usdc = new MockERC20();
        recipient = bytes32(uint256(uint160(recipientAddr)));

        BasejumpLandingEvm impl = new BasejumpLandingEvm();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(BasejumpLandingEvm.initialize, ())
        );
        landing = BasejumpLandingEvm(address(proxy));

        landing.setAuthorizedBridge(bridge, true);
        usdc.mint(address(landing), POOL_AMOUNT);
    }

    // ─── Deployment ──────────────────────────────────────────────

    function testDeployment() public view {
        assertEq(landing.owner(), address(this));
        assertTrue(landing.authorizedBridges(bridge));
        assertEq(landing.pendingHead(), 0);
        assertEq(landing.pendingTail(), 0);
    }

    function testCannotReinitialize() public {
        vm.expectRevert();
        landing.initialize();
    }

    // ─── Immediate delivery (EOA recipient, empty data) ──────────

    function testTransferDeliversToEoa() public {
        uint256 amount = 1_000e6;

        vm.expectEmit(true, true, false, true);
        emit IBasejumpLandingEvm.TransferExecuted(address(usdc), recipientAddr, amount);

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
        vm.expectRevert(IBasejumpLandingEvm.NotAuthorizedBridge.selector);
        landing.transfer(address(usdc), 1_000e6, recipient, "");
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
            abi.encodeWithSelector(IBasejumpLandingEvm.ReceiverNotContract.selector, recipientAddr)
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

        vm.expectEmit(true, true, true, true);
        emit IBasejumpLandingEvm.TransferQueued(0, address(usdc), recipientAddr, over);

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
            abi.encodeWithSelector(IBasejumpLandingEvm.ReceiverNotContract.selector, recipientAddr)
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

        vm.expectEmit(true, true, true, true);
        emit IBasejumpLandingEvm.PendingTransferFulfilled(0, address(usdc), recipientAddr, over);

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
        vm.expectRevert(IBasejumpLandingEvm.NoPendingTransfers.selector);
        landing.fulfillPending();
    }

    function testFulfillPendingRevertsInsufficientBalance() public {
        uint256 over = POOL_AMOUNT + 1e6;

        vm.prank(bridge);
        landing.transfer(address(usdc), over, recipient, "");

        // Don't replenish — drain still impossible
        vm.expectRevert(IBasejumpLandingEvm.InsufficientBalance.selector);
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

    function testWithdrawRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(IBasejumpLandingEvm.NotOwner.selector);
        landing.withdraw(address(usdc), 1, stranger);
    }

    function testSetOwner() public {
        address newOwner = makeAddr("newOwner");
        landing.setOwner(newOwner);
        assertEq(landing.owner(), newOwner);
    }
}
