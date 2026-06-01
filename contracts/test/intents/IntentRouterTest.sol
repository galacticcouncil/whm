// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {IntentRouter} from "../../src/intents/IntentRouter.sol";
import {IIntentRouter} from "../../src/intents/interfaces/IIntentRouter.sol";

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

contract IntentRouterTest is Test {
    IntentRouter public router;
    MockERC20 public usdc;
    MockERC20 public otherToken;

    address public landing = makeAddr("basejumpLanding");
    address public stranger = makeAddr("stranger");
    address public depositAddress = makeAddr("depositAddress");
    bytes32 public intentId = keccak256("intent-1");

    function setUp() public {
        usdc = new MockERC20();
        otherToken = new MockERC20();

        IntentRouter impl = new IntentRouter();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(IntentRouter.initialize, (landing))
        );
        router = IntentRouter(address(proxy));
    }

    // ─── Deployment ──────────────────────────────────────────────

    function testDeployment() public view {
        assertEq(router.owner(), address(this));
        assertEq(router.basejumpLanding(), landing);
    }

    function testCannotReinitialize() public {
        vm.expectRevert();
        router.initialize(landing);
    }

    // ─── onBasejumpReceive ───────────────────────────────────────

    function testForwardsAssetToDepositAddress() public {
        uint256 amount = 1_234e6;

        // Simulate the landing having already transferred USDC to the router
        usdc.mint(address(router), amount);

        bytes memory data = abi.encode(intentId, depositAddress);

        vm.expectEmit(true, true, true, true);
        emit IIntentRouter.IntentForwarded(intentId, address(usdc), depositAddress, amount);

        vm.prank(landing);
        router.onBasejumpReceive(address(usdc), amount, data);

        assertEq(usdc.balanceOf(depositAddress), amount);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function testForwardsAnyAsset() public {
        // Router is asset-agnostic — whatever the authorized landing delivers, it forwards.
        uint256 amount = 500e6;
        otherToken.mint(address(router), amount);

        bytes memory data = abi.encode(intentId, depositAddress);

        vm.expectEmit(true, true, true, true);
        emit IIntentRouter.IntentForwarded(intentId, address(otherToken), depositAddress, amount);

        vm.prank(landing);
        router.onBasejumpReceive(address(otherToken), amount, data);

        assertEq(otherToken.balanceOf(depositAddress), amount);
    }

    function testRevertsWhenSenderNotLanding() public {
        usdc.mint(address(router), 1_000e6);
        bytes memory data = abi.encode(intentId, depositAddress);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IIntentRouter.NotBasejumpLanding.selector, stranger));
        router.onBasejumpReceive(address(usdc), 1_000e6, data);
    }

    function testRevertsOnMalformedData() public {
        // wrong length (not 64 bytes)
        bytes memory badData = hex"deadbeef";

        vm.prank(landing);
        vm.expectRevert(IIntentRouter.MalformedData.selector);
        router.onBasejumpReceive(address(usdc), 1_000e6, badData);
    }

    function testRevertsOnZeroDepositAddress() public {
        usdc.mint(address(router), 1_000e6);
        bytes memory data = abi.encode(intentId, address(0));

        vm.prank(landing);
        vm.expectRevert(IIntentRouter.InvalidDepositAddress.selector);
        router.onBasejumpReceive(address(usdc), 1_000e6, data);
    }

    // ─── Admin ───────────────────────────────────────────────────

    function testSweep() public {
        usdc.mint(address(router), 500e6);
        address to = makeAddr("rescue");

        vm.expectEmit(true, true, false, true);
        emit IIntentRouter.Swept(address(usdc), to, 500e6);

        router.sweep(address(usdc), to, 500e6);
        assertEq(usdc.balanceOf(to), 500e6);
    }

    function testSweepRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(IIntentRouter.NotOwner.selector);
        router.sweep(address(usdc), stranger, 1);
    }

    function testSetBasejumpLanding() public {
        address newLanding = makeAddr("newLanding");
        router.setBasejumpLanding(newLanding);
        assertEq(router.basejumpLanding(), newLanding);
    }

    function testSetBasejumpLandingRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(IIntentRouter.NotOwner.selector);
        router.setBasejumpLanding(makeAddr("x"));
    }

    function testSetOwner() public {
        address newOwner = makeAddr("newOwner");
        router.setOwner(newOwner);
        assertEq(router.owner(), newOwner);
    }
}
