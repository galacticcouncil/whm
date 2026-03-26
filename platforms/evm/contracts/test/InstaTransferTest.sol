// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

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

        InstaTransfer impl = new InstaTransfer();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(InstaTransfer.initialize, ())
        );
        instaTransfer = InstaTransfer(address(proxy));

        instaTransfer.setAuthorizedBridge(bridge, true);
        instaTransfer.setAllowedAssetPair(address(sourceUsdc), address(usdc), true);

        usdc.mint(address(instaTransfer), POOL_AMOUNT);

        // Mock the dispatch precompile to succeed (empty return = success)
        vm.mockCall(DISPATCH_PRECOMPILE, bytes(""), bytes(""));
    }

    // ─── Deployment ──────────────────────────────────────────────

    function testDeployment() public view {
        assertEq(instaTransfer.owner(), address(this));
        assertEq(instaTransfer.authorizedBridges(bridge), true);
        assertEq(instaTransfer.DISPATCH(), DISPATCH_PRECOMPILE);
        assertEq(instaTransfer.CURRENCIES_PALLET_INDEX(), 79);
        assertEq(instaTransfer.CURRENCIES_TRANSFER_INDEX(), 0);
    }

    function testCannotReinitialize() public {
        vm.expectRevert();
        instaTransfer.initialize();
    }

    // ─── Transfer ──────────────────────────────────────────────

    function testTransfer() public {
        uint256 amount = 1_000e6;

        vm.prank(bridge);
        instaTransfer.transfer(address(sourceUsdc), address(usdc), amount, recipient);

        // Pool balance reduced (used for balance check)
        assertEq(usdc.balanceOf(address(instaTransfer)), POOL_AMOUNT);
    }

    function testTransferEmitsEvent() public {
        uint256 amount = 1_000e6;

        vm.expectEmit(true, true, true, true);
        emit InstaTransfer.TransferExecuted(address(sourceUsdc), address(usdc), recipient, amount);

        vm.prank(bridge);
        instaTransfer.transfer(address(sourceUsdc), address(usdc), amount, recipient);
    }

    function testTransferCallsDispatch() public {
        uint256 amount = 1_000e6;

        // Expect a call to dispatch precompile (any calldata)
        vm.expectCall(DISPATCH_PRECOMPILE, bytes(""));

        vm.prank(bridge);
        instaTransfer.transfer(address(sourceUsdc), address(usdc), amount, recipient);
    }

    function testTransferRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(InstaTransfer.NotAuthorizedBridge.selector);
        instaTransfer.transfer(address(sourceUsdc), address(usdc), 1_000e6, recipient);
    }

    function testTransferRevertsAssetPairNotAllowed() public {
        address disallowedSource = makeAddr("disallowedSource");

        vm.prank(bridge);
        vm.expectRevert(abi.encodeWithSelector(InstaTransfer.AssetPairNotAllowed.selector, disallowedSource, address(usdc)));
        instaTransfer.transfer(disallowedSource, address(usdc), 1_000e6, recipient);
    }

    function testTransferRevertsOnDispatchFailure() public {
        // Clear the mock and make dispatch revert
        vm.mockCallRevert(DISPATCH_PRECOMPILE, bytes(""), bytes("dispatch failed"));

        vm.prank(bridge);
        vm.expectRevert(InstaTransfer.DispatchFailed.selector);
        instaTransfer.transfer(address(sourceUsdc), address(usdc), 1_000e6, recipient);
    }

    function testTransferQueuesWhenInsufficientBalance() public {
        uint256 overAmount = POOL_AMOUNT + 1e6;

        vm.expectEmit(true, true, true, true);
        emit InstaTransfer.TransferQueued(0, address(sourceUsdc), address(usdc), recipient, overAmount);

        vm.prank(bridge);
        instaTransfer.transfer(address(sourceUsdc), address(usdc), overAmount, recipient);

        // Pool untouched
        assertEq(usdc.balanceOf(address(instaTransfer)), POOL_AMOUNT);
        // Pending transfer stored
        (address srcAsset, address dstAsset, uint256 amount, bytes32 rec) = instaTransfer.pendingTransfers(0);
        assertEq(srcAsset, address(sourceUsdc));
        assertEq(dstAsset, address(usdc));
        assertEq(amount, overAmount);
        assertEq(rec, recipient);
        assertEq(instaTransfer.nextPendingId(), 1);
    }

    // ─── Pending Transfers ────────────────────────────────────────

    function testFulfillPending() public {
        uint256 overAmount = POOL_AMOUNT + 1e6;

        // Queue a transfer
        vm.prank(bridge);
        instaTransfer.transfer(address(sourceUsdc), address(usdc), overAmount, recipient);

        // Replenish the pool (simulates slow bridge settlement)
        usdc.mint(address(instaTransfer), 10e6);

        // Fulfill
        vm.expectEmit(true, true, true, true);
        emit InstaTransfer.PendingTransferFulfilled(0, address(sourceUsdc), address(usdc), recipient, overAmount);

        instaTransfer.fulfillPending(0);

        // Pending transfer deleted
        (address srcAsset,,,) = instaTransfer.pendingTransfers(0);
        assertEq(srcAsset, address(0));
    }

    function testFulfillPendingCallsDispatch() public {
        uint256 overAmount = POOL_AMOUNT + 1e6;

        vm.prank(bridge);
        instaTransfer.transfer(address(sourceUsdc), address(usdc), overAmount, recipient);

        usdc.mint(address(instaTransfer), 10e6);

        // Expect a call to dispatch precompile (any calldata)
        vm.expectCall(DISPATCH_PRECOMPILE, bytes(""));

        instaTransfer.fulfillPending(0);
    }

    function testFulfillPendingRevertsNotFound() public {
        vm.expectRevert(abi.encodeWithSelector(InstaTransfer.PendingTransferNotFound.selector, 99));
        instaTransfer.fulfillPending(99);
    }

    function testFulfillPendingRevertsInsufficientBalance() public {
        uint256 overAmount = POOL_AMOUNT + 1e6;

        vm.prank(bridge);
        instaTransfer.transfer(address(sourceUsdc), address(usdc), overAmount, recipient);

        // Don't replenish — should revert
        vm.expectRevert(InstaTransfer.InsufficientBalance.selector);
        instaTransfer.fulfillPending(0);
    }

    function testFulfillPendingCannotDoubleFulfill() public {
        uint256 overAmount = POOL_AMOUNT + 1e6;

        vm.prank(bridge);
        instaTransfer.transfer(address(sourceUsdc), address(usdc), overAmount, recipient);

        usdc.mint(address(instaTransfer), 10e6);
        instaTransfer.fulfillPending(0);

        // Second attempt — pending was deleted
        vm.expectRevert(abi.encodeWithSelector(InstaTransfer.PendingTransferNotFound.selector, 0));
        instaTransfer.fulfillPending(0);
    }

    function testMultiplePendingTransfers() public {
        // Queue three transfers that all exceed the pool
        vm.startPrank(bridge);
        instaTransfer.transfer(address(sourceUsdc), address(usdc), POOL_AMOUNT + 1, recipient);
        instaTransfer.transfer(address(sourceUsdc), address(usdc), POOL_AMOUNT + 5_000e6, recipient);
        instaTransfer.transfer(address(sourceUsdc), address(usdc), POOL_AMOUNT + 3_000e6, recipient);
        vm.stopPrank();

        assertEq(instaTransfer.nextPendingId(), 3);

        // Replenish and fulfill all
        usdc.mint(address(instaTransfer), POOL_AMOUNT * 3 + 10_000e6);
        instaTransfer.fulfillPending(0);
        instaTransfer.fulfillPending(1);
        instaTransfer.fulfillPending(2);

        // All pending transfers deleted
        (address srcAsset0,,,) = instaTransfer.pendingTransfers(0);
        (address srcAsset1,,,) = instaTransfer.pendingTransfers(1);
        (address srcAsset2,,,) = instaTransfer.pendingTransfers(2);
        assertEq(srcAsset0, address(0));
        assertEq(srcAsset1, address(0));
        assertEq(srcAsset2, address(0));
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

    // ─── Asset Pair Validation ────────────────────────────────────

    function testSetAllowedAssetPair() public {
        address newSource = makeAddr("newSource");
        address newDest = makeAddr("newDest");

        assertEq(instaTransfer.allowedAssetPairs(newSource, newDest), false);

        vm.expectEmit(true, true, false, true);
        emit InstaTransfer.AllowedAssetPairUpdated(newSource, newDest, true);

        instaTransfer.setAllowedAssetPair(newSource, newDest, true);
        assertEq(instaTransfer.allowedAssetPairs(newSource, newDest), true);

        instaTransfer.setAllowedAssetPair(newSource, newDest, false);
        assertEq(instaTransfer.allowedAssetPairs(newSource, newDest), false);
    }

    function testSetAllowedAssetPairRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(InstaTransfer.NotOwner.selector);
        instaTransfer.setAllowedAssetPair(address(sourceUsdc), address(usdc), false);
    }

    function testTransferAfterAssetPairDisabled() public {
        // Disable the asset pair
        instaTransfer.setAllowedAssetPair(address(sourceUsdc), address(usdc), false);

        // Transfer should now revert
        vm.prank(bridge);
        vm.expectRevert(abi.encodeWithSelector(InstaTransfer.AssetPairNotAllowed.selector, address(sourceUsdc), address(usdc)));
        instaTransfer.transfer(address(sourceUsdc), address(usdc), 1_000e6, recipient);
    }

    // ─── AccountId32 Recipient ────────────────────────────────────

    function testTransferWithAccountId32() public {
        // A typical Polkadot AccountId32 (not a valid EVM address)
        bytes32 polkadotRecipient = bytes32(0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef);
        instaTransfer.setAllowedAssetPair(address(sourceUsdc), address(usdc), true);

        uint256 amount = 1_000e6;

        vm.expectEmit(true, true, true, true);
        emit InstaTransfer.TransferExecuted(address(sourceUsdc), address(usdc), polkadotRecipient, amount);

        vm.prank(bridge);
        instaTransfer.transfer(address(sourceUsdc), address(usdc), amount, polkadotRecipient);
    }
}
