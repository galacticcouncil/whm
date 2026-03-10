// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

import {InstaTransfer} from "../src/InstaTransfer.sol";

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

contract InstaTransferTest is Test {
    InstaTransfer public instaTransfer;
    MockERC20 public usdc;

    address public bridge = makeAddr("bridge");
    address public recipient = makeAddr("recipient");
    address public stranger = makeAddr("stranger");

    uint256 constant POOL_AMOUNT = 100_000e6;

    function setUp() public {
        usdc = new MockERC20();

        InstaTransfer impl = new InstaTransfer();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(InstaTransfer.initialize, ())
        );
        instaTransfer = InstaTransfer(address(proxy));

        instaTransfer.setAuthorizedBridge(bridge, true);

        usdc.mint(address(instaTransfer), POOL_AMOUNT);
    }

    // ─── Deployment ──────────────────────────────────────────────

    function testDeployment() public view {
        assertEq(instaTransfer.owner(), address(this));
        assertEq(instaTransfer.authorizedBridges(bridge), true);
    }

    function testCannotReinitialize() public {
        vm.expectRevert();
        instaTransfer.initialize();
    }

    // ─── Transfer ──────────────────────────────────────────────

    function testTransfer() public {
        uint256 amount = 1_000e6;

        vm.prank(bridge);
        instaTransfer.transfer(recipient, address(usdc), amount);

        assertEq(usdc.balanceOf(recipient), amount);
        assertEq(usdc.balanceOf(address(instaTransfer)), POOL_AMOUNT - amount);
    }

    function testTransferEmitsEvent() public {
        uint256 amount = 1_000e6;

        vm.expectEmit(true, true, false, true);
        emit InstaTransfer.TransferExecuted(address(usdc), recipient, amount);

        vm.prank(bridge);
        instaTransfer.transfer(recipient, address(usdc), amount);
    }

    function testTransferMultiple() public {
        vm.startPrank(bridge);
        instaTransfer.transfer(recipient, address(usdc), 1_000e6);
        instaTransfer.transfer(recipient, address(usdc), 2_000e6);
        vm.stopPrank();

        assertEq(usdc.balanceOf(recipient), 3_000e6);
    }

    function testTransferRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(InstaTransfer.NotAuthorizedBridge.selector);
        instaTransfer.transfer(recipient, address(usdc), 1_000e6);
    }

    function testTransferQueuesWhenInsufficientBalance() public {
        uint256 overAmount = POOL_AMOUNT + 1e6;

        vm.expectEmit(true, true, true, true);
        emit InstaTransfer.TransferQueued(0, address(usdc), recipient, overAmount);

        vm.prank(bridge);
        instaTransfer.transfer(recipient, address(usdc), overAmount);

        // Recipient gets nothing yet
        assertEq(usdc.balanceOf(recipient), 0);
        // Pool untouched
        assertEq(usdc.balanceOf(address(instaTransfer)), POOL_AMOUNT);
        // Pending transfer stored
        (address asset, uint256 amount, address rec) = instaTransfer.pendingTransfers(0);
        assertEq(asset, address(usdc));
        assertEq(amount, overAmount);
        assertEq(rec, recipient);
        assertEq(instaTransfer.nextPendingId(), 1);
    }

    // ─── Pending Transfers ────────────────────────────────────────

    function testFulfillPending() public {
        uint256 overAmount = POOL_AMOUNT + 1e6;

        // Queue a transfer
        vm.prank(bridge);
        instaTransfer.transfer(recipient, address(usdc), overAmount);

        // Replenish the pool (simulates slow bridge settlement)
        usdc.mint(address(instaTransfer), 10e6);

        // Fulfill
        vm.expectEmit(true, true, true, true);
        emit InstaTransfer.PendingTransferFulfilled(0, address(usdc), recipient, overAmount);

        instaTransfer.fulfillPending(0);

        assertEq(usdc.balanceOf(recipient), overAmount);
        // Pending transfer deleted
        (address asset,,) = instaTransfer.pendingTransfers(0);
        assertEq(asset, address(0));
    }

    function testFulfillPendingRevertsNotFound() public {
        vm.expectRevert(abi.encodeWithSelector(InstaTransfer.PendingTransferNotFound.selector, 99));
        instaTransfer.fulfillPending(99);
    }

    function testFulfillPendingRevertsInsufficientBalance() public {
        uint256 overAmount = POOL_AMOUNT + 1e6;

        vm.prank(bridge);
        instaTransfer.transfer(recipient, address(usdc), overAmount);

        // Don't replenish — should revert
        vm.expectRevert(InstaTransfer.InsufficientBalance.selector);
        instaTransfer.fulfillPending(0);
    }

    function testFulfillPendingCannotDoubleFulfill() public {
        uint256 overAmount = POOL_AMOUNT + 1e6;

        vm.prank(bridge);
        instaTransfer.transfer(recipient, address(usdc), overAmount);

        usdc.mint(address(instaTransfer), 10e6);
        instaTransfer.fulfillPending(0);

        // Second attempt — pending was deleted
        vm.expectRevert(abi.encodeWithSelector(InstaTransfer.PendingTransferNotFound.selector, 0));
        instaTransfer.fulfillPending(0);
    }

    function testMultiplePendingTransfers() public {
        // Drain the pool
        vm.prank(bridge);
        instaTransfer.transfer(recipient, address(usdc), POOL_AMOUNT);

        // Queue two pending transfers
        vm.startPrank(bridge);
        instaTransfer.transfer(recipient, address(usdc), 5_000e6);
        instaTransfer.transfer(recipient, address(usdc), 3_000e6);
        vm.stopPrank();

        assertEq(instaTransfer.nextPendingId(), 2);

        // Replenish and fulfill both
        usdc.mint(address(instaTransfer), 10_000e6);
        instaTransfer.fulfillPending(0);
        instaTransfer.fulfillPending(1);

        assertEq(usdc.balanceOf(recipient), POOL_AMOUNT + 5_000e6 + 3_000e6);
    }

    function testTransferFuzz(uint256 amount) public {
        amount = bound(amount, 1, POOL_AMOUNT);

        vm.prank(bridge);
        instaTransfer.transfer(recipient, address(usdc), amount);

        assertEq(usdc.balanceOf(recipient), amount);
        assertEq(usdc.balanceOf(address(instaTransfer)), POOL_AMOUNT - amount);
    }

    // ─── Admin ───────────────────────────────────────────────────

    function testWithdraw() public {
        address dest = makeAddr("dest");
        instaTransfer.withdraw(address(usdc), 50_000e6, dest);
        assertEq(usdc.balanceOf(dest), 50_000e6);
    }

    function testWithdrawEmitsEvent() public {
        address dest = makeAddr("dest");

        vm.expectEmit(true, true, false, true);
        emit InstaTransfer.Withdrawn(address(usdc), 50_000e6, dest);

        instaTransfer.withdraw(address(usdc), 50_000e6, dest);
    }

    function testWithdrawRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(InstaTransfer.NotOwner.selector);
        instaTransfer.withdraw(address(usdc), 1, stranger);
    }

    function testSetAuthorizedBridge() public {
        address newBridge = makeAddr("newBridge");
        instaTransfer.setAuthorizedBridge(newBridge, true);
        assertEq(instaTransfer.authorizedBridges(newBridge), true);

        instaTransfer.setAuthorizedBridge(newBridge, false);
        assertEq(instaTransfer.authorizedBridges(newBridge), false);
    }

    function testSetAuthorizedBridgeRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(InstaTransfer.NotOwner.selector);
        instaTransfer.setAuthorizedBridge(bridge, false);
    }

    function testSetOwner() public {
        address newOwner = makeAddr("newOwner");
        instaTransfer.setOwner(newOwner);
        assertEq(instaTransfer.owner(), newOwner);
    }

    function testSetOwnerRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(InstaTransfer.NotOwner.selector);
        instaTransfer.setOwner(stranger);
    }
}