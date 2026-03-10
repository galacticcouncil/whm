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
        instaTransfer.transfer(address(usdc), amount, recipient);

        assertEq(usdc.balanceOf(recipient), amount);
        assertEq(usdc.balanceOf(address(instaTransfer)), POOL_AMOUNT - amount);
    }

    function testTransferEmitsEvent() public {
        uint256 amount = 1_000e6;

        vm.expectEmit(true, true, false, true);
        emit InstaTransfer.TransferExecuted(address(usdc), recipient, amount);

        vm.prank(bridge);
        instaTransfer.transfer(address(usdc), amount, recipient);
    }

    function testTransferMultiple() public {
        vm.startPrank(bridge);
        instaTransfer.transfer(address(usdc), 1_000e6, recipient);
        instaTransfer.transfer(address(usdc), 2_000e6, recipient);
        vm.stopPrank();

        assertEq(usdc.balanceOf(recipient), 3_000e6);
    }

    function testTransferRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(InstaTransfer.NotAuthorizedBridge.selector);
        instaTransfer.transfer(address(usdc), 1_000e6, recipient);
    }

    function testTransferRevertsInsufficientBalance() public {
        vm.prank(bridge);
        vm.expectRevert();
        instaTransfer.transfer(address(usdc), POOL_AMOUNT + 1e6, recipient);
    }

    function testTransferFuzz(uint256 amount) public {
        amount = bound(amount, 1, POOL_AMOUNT);

        vm.prank(bridge);
        instaTransfer.transfer(address(usdc), amount, recipient);

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