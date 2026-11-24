// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {SnowbridgeConverter} from "../../src/snowbridge/SnowbridgeConverter.sol";
import {ISnowbridgeConverter} from "../../src/snowbridge/interfaces/ISnowbridgeConverter.sol";

contract MockToken {
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

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
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        allowance[from][msg.sender] -= amount;
        return true;
    }
}

contract SnowbridgeConverterV2 is SnowbridgeConverter {
    function version() external pure returns (uint256) {
        return 2;
    }
}

contract SnowbridgeConverterTest is Test {
    SnowbridgeConverter public converter;

    MockToken public ethSb;
    MockToken public wethSb;
    MockToken public wethNtt;
    MockToken public usdcSb;
    MockToken public usdcNtt;

    address public user = makeAddr("user");
    address public other = makeAddr("other");
    address public pauserAddr = makeAddr("pauser");

    uint256 constant WETH_INVENTORY = 100e18;
    uint256 constant USDC_INVENTORY = 1_000_000e6;

    function setUp() public {
        ethSb = new MockToken(18);
        wethSb = new MockToken(18);
        wethNtt = new MockToken(18);
        usdcSb = new MockToken(6);
        usdcNtt = new MockToken(6);

        SnowbridgeConverter impl = new SnowbridgeConverter();
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), abi.encodeCall(SnowbridgeConverter.initialize, ()));
        converter = SnowbridgeConverter(address(proxy));

        converter.setPair(address(ethSb), address(wethNtt));
        converter.setPair(address(wethSb), address(wethNtt));
        converter.setPair(address(usdcSb), address(usdcNtt));
        converter.setPauser(pauserAddr);

        wethNtt.mint(address(converter), WETH_INVENTORY);
        usdcNtt.mint(address(converter), USDC_INVENTORY);

        ethSb.mint(user, 1_000e18);
        usdcSb.mint(user, 10_000_000e6);
        vm.startPrank(user);
        ethSb.approve(address(converter), type(uint256).max);
        usdcSb.approve(address(converter), type(uint256).max);
        vm.stopPrank();
    }

    // ─── Init ────────────────────────────────────────────────────

    function testInitialState() public view {
        assertEq(converter.owner(), address(this));
        assertEq(converter.pauser(), pauserAddr);
        assertFalse(converter.paused());
        assertEq(converter.targetOf(address(ethSb)), address(wethNtt));
        assertEq(converter.targetRefs(address(wethNtt)), 2);
        assertTrue(converter.isTarget(address(wethNtt)));
        assertEq(converter.available(address(usdcSb)), USDC_INVENTORY);
        assertEq(converter.available(address(this)), 0);
    }

    function testCannotReinitialize() public {
        vm.expectRevert();
        converter.initialize();
    }

    // ─── Convert ─────────────────────────────────────────────────

    function testConvert() public {
        vm.expectEmit(address(converter));
        emit ISnowbridgeConverter.Converted(address(usdcSb), address(usdcNtt), user, user, 250_000e6);

        vm.prank(user);
        converter.convert(address(usdcSb), 250_000e6);

        assertEq(usdcNtt.balanceOf(user), 250_000e6);
        assertEq(usdcSb.balanceOf(user), 9_750_000e6);
        assertEq(usdcSb.balanceOf(address(converter)), 250_000e6);
        assertEq(converter.available(address(usdcSb)), USDC_INVENTORY - 250_000e6);
    }

    function testConvertTo() public {
        vm.prank(user);
        converter.convertTo(address(ethSb), 3e18, other);

        assertEq(wethNtt.balanceOf(other), 3e18);
        assertEq(wethNtt.balanceOf(user), 0);
        assertEq(ethSb.balanceOf(address(converter)), 3e18);
    }

    function testConvertToZeroAddressReverts() public {
        vm.prank(user);
        vm.expectRevert(ISnowbridgeConverter.ZeroAddress.selector);
        converter.convertTo(address(ethSb), 1e18, address(0));
    }

    function testSharedTargetDrainsOneInventory() public {
        wethSb.mint(user, 10e18);
        vm.startPrank(user);
        wethSb.approve(address(converter), type(uint256).max);
        converter.convert(address(ethSb), 95e18);
        converter.convert(address(wethSb), 5e18);
        vm.expectRevert(
            abi.encodeWithSelector(ISnowbridgeConverter.InsufficientInventory.selector, address(wethNtt), 0)
        );
        converter.convert(address(wethSb), 1);
        vm.stopPrank();

        assertEq(wethNtt.balanceOf(user), WETH_INVENTORY);
    }

    function testConvertWholeInventory() public {
        vm.prank(user);
        converter.convert(address(usdcSb), USDC_INVENTORY);
        assertEq(converter.available(address(usdcSb)), 0);
    }

    function testConvertInsufficientInventoryReverts() public {
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(
                ISnowbridgeConverter.InsufficientInventory.selector, address(usdcNtt), USDC_INVENTORY
            )
        );
        converter.convert(address(usdcSb), USDC_INVENTORY + 1);
    }

    function testConvertUnknownSourceReverts() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ISnowbridgeConverter.PairNotSet.selector, address(usdcNtt)));
        converter.convert(address(usdcNtt), 1);
    }

    function testConvertZeroReverts() public {
        vm.prank(user);
        vm.expectRevert(ISnowbridgeConverter.ZeroAmount.selector);
        converter.convert(address(usdcSb), 0);
    }

    function testConvertWithoutAllowanceReverts() public {
        usdcSb.mint(other, 1e6);
        vm.prank(other);
        vm.expectRevert();
        converter.convert(address(usdcSb), 1e6);
    }

    function testFuzzConvertConservesBalances(uint256 amount) public {
        amount = bound(amount, 1, USDC_INVENTORY);
        uint256 userBefore = usdcSb.balanceOf(user) + usdcNtt.balanceOf(user);
        uint256 converterBefore = usdcSb.balanceOf(address(converter)) + usdcNtt.balanceOf(address(converter));

        vm.prank(user);
        converter.convert(address(usdcSb), amount);

        assertEq(usdcSb.balanceOf(user) + usdcNtt.balanceOf(user), userBefore);
        assertEq(usdcSb.balanceOf(address(converter)) + usdcNtt.balanceOf(address(converter)), converterBefore);
        assertEq(usdcNtt.balanceOf(user), amount);
    }

    // ─── Pairs ───────────────────────────────────────────────────

    function testSetPairDecimalsMismatchReverts() public {
        MockToken odd = new MockToken(8);
        vm.expectRevert(abi.encodeWithSelector(ISnowbridgeConverter.DecimalsMismatch.selector, 8, 6));
        converter.setPair(address(odd), address(usdcNtt));
    }

    function testSetPairSelfReverts() public {
        MockToken t = new MockToken(18);
        vm.expectRevert(abi.encodeWithSelector(ISnowbridgeConverter.InvalidPair.selector, address(t), address(t)));
        converter.setPair(address(t), address(t));
    }

    function testSetPairTargetAsSourceReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(ISnowbridgeConverter.InvalidPair.selector, address(wethNtt), address(usdcNtt))
        );
        converter.setPair(address(wethNtt), address(usdcNtt));
    }

    function testSetPairSourceAsTargetReverts() public {
        MockToken t = new MockToken(6);
        vm.expectRevert(abi.encodeWithSelector(ISnowbridgeConverter.InvalidPair.selector, address(t), address(usdcSb)));
        converter.setPair(address(t), address(usdcSb));
    }

    function testSetPairZeroSourceReverts() public {
        vm.expectRevert(ISnowbridgeConverter.ZeroAddress.selector);
        converter.setPair(address(0), address(usdcNtt));
    }

    function testDisablePair() public {
        converter.setPair(address(ethSb), address(0));
        assertEq(converter.targetOf(address(ethSb)), address(0));
        assertEq(converter.targetRefs(address(wethNtt)), 1);
        assertEq(converter.available(address(ethSb)), 0);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ISnowbridgeConverter.PairNotSet.selector, address(ethSb)));
        converter.convert(address(ethSb), 1e18);
    }

    function testRepointPairMovesRefs() public {
        MockToken weth2 = new MockToken(18);
        converter.setPair(address(ethSb), address(weth2));
        assertEq(converter.targetRefs(address(wethNtt)), 1);
        assertEq(converter.targetRefs(address(weth2)), 1);

        converter.setPair(address(ethSb), address(weth2));
        assertEq(converter.targetRefs(address(weth2)), 1);
    }

    function testFormerTargetCanBecomeSource() public {
        converter.setPair(address(usdcSb), address(0));
        assertFalse(converter.isTarget(address(usdcNtt)));
        MockToken usdc2 = new MockToken(6);
        converter.setPair(address(usdcNtt), address(usdc2));
        assertEq(converter.targetOf(address(usdcNtt)), address(usdc2));
    }

    function testSetPairOnlyOwner() public {
        vm.prank(other);
        vm.expectRevert(ISnowbridgeConverter.NotOwner.selector);
        converter.setPair(address(usdcSb), address(0));
    }

    // ─── Pause ───────────────────────────────────────────────────

    function testPauserPausesOnlyOwnerResumes() public {
        vm.prank(pauserAddr);
        converter.setPaused(true);
        assertTrue(converter.paused());

        vm.prank(user);
        vm.expectRevert(ISnowbridgeConverter.IsPaused.selector);
        converter.convert(address(usdcSb), 1e6);

        vm.prank(pauserAddr);
        vm.expectRevert(ISnowbridgeConverter.NotOwner.selector);
        converter.setPaused(false);

        converter.setPaused(false);
        vm.prank(user);
        converter.convert(address(usdcSb), 1e6);
    }

    function testOwnerCanPause() public {
        converter.setPaused(true);
        assertTrue(converter.paused());
    }

    function testStrangerCannotPause() public {
        vm.prank(other);
        vm.expectRevert(ISnowbridgeConverter.NotPauser.selector);
        converter.setPaused(true);
    }

    // ─── Admin ───────────────────────────────────────────────────

    function testWithdrawOnlyOwner() public {
        vm.prank(other);
        vm.expectRevert(ISnowbridgeConverter.NotOwner.selector);
        converter.withdraw(address(usdcNtt), 1, other);

        converter.withdraw(address(usdcNtt), 1e6, other);
        assertEq(usdcNtt.balanceOf(other), 1e6);
    }

    function testSetOwner() public {
        converter.setOwner(other);
        assertEq(converter.owner(), other);

        vm.expectRevert(ISnowbridgeConverter.NotOwner.selector);
        converter.setPauser(other);
    }

    function testSetOwnerZeroReverts() public {
        vm.expectRevert(ISnowbridgeConverter.ZeroAddress.selector);
        converter.setOwner(address(0));
    }

    function testAdminSettersOnlyOwner() public {
        vm.startPrank(other);
        vm.expectRevert(ISnowbridgeConverter.NotOwner.selector);
        converter.setOwner(other);
        vm.expectRevert(ISnowbridgeConverter.NotOwner.selector);
        converter.setPauser(other);
        vm.stopPrank();
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function testUpgradeOnlyOwner() public {
        SnowbridgeConverterV2 v2 = new SnowbridgeConverterV2();

        vm.prank(other);
        vm.expectRevert(ISnowbridgeConverter.NotOwner.selector);
        converter.upgradeToAndCall(address(v2), "");

        converter.upgradeToAndCall(address(v2), "");
        assertEq(SnowbridgeConverterV2(address(converter)).version(), 2);
        assertEq(converter.targetOf(address(usdcSb)), address(usdcNtt));
        assertEq(converter.available(address(usdcSb)), USDC_INVENTORY);
    }
}
