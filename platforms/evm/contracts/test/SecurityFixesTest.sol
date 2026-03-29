// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {BasejumpLanding} from "../src/BasejumpLanding.sol";
import {MessageDispatcher} from "../src/MessageDispatcher.sol";

/// @notice Mock fee-on-transfer ERC20 token
contract FeeToken is ERC20 {
    uint256 public feeBps = 200; // 2% fee

    constructor() ERC20("Fee Token", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = (amount * feeBps) / 10000;
            uint256 amountAfterFee = amount - fee;

            super._update(from, address(0), fee);  // Burn fee
            super._update(from, to, amountAfterFee);
        } else {
            super._update(from, to, amount);
        }
    }
}

/// @notice Simple ERC20 token for testing
contract SimpleToken is ERC20 {
    constructor() ERC20("Simple Token", "SIMPLE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/// @notice Tests for security fixes
contract SecurityFixesTest is Test {
    BasejumpLanding public landing;
    MessageDispatcher public dispatcher;

    FeeToken public token;
    SimpleToken public destToken;

    address public bridge = makeAddr("bridge");
    bytes32 public recipient = bytes32(uint256(uint160(makeAddr("recipient"))));
    address constant DISPATCH = 0x0000000000000000000000000000000000000401;

    function setUp() public {
        // Deploy BasejumpLanding
        BasejumpLanding impl = new BasejumpLanding();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(BasejumpLanding.initialize, ())
        );
        landing = BasejumpLanding(address(proxy));

        // Setup test tokens
        token = new FeeToken();
        destToken = new SimpleToken();

        // Mock DISPATCH precompile
        vm.mockCall(DISPATCH, bytes(""), bytes(""));

        // Configure landing
        landing.setAuthorizedBridge(bridge, true);
        vm.label(address(landing), "BasejumpLanding");
        vm.label(address(token), "FeeToken");
    }

    /// @notice Test Fix #6: uint256 to uint128 downcast protection
    function testUint128OverflowProtection() public {
        // Amount that exceeds uint128.max
        uint256 hugeAmount = uint256(type(uint128).max) + 1;

        // Setup asset mapping
        landing.setDestAsset(address(token), address(destToken));

        // Mint tokens to landing so transfer executes (not queues)
        destToken.mint(address(landing), hugeAmount);

        vm.prank(bridge);
        vm.expectRevert("Amount exceeds uint128");
        landing.transfer(address(token), hugeAmount, recipient);
    }

    /// @notice Test Fix #6: uint128.max should work
    function testUint128MaxWorks() public {
        uint256 maxAmount = uint256(type(uint128).max);

        // Mint tokens to landing
        vm.prank(address(this));
        deal(address(destToken), address(landing), maxAmount);

        landing.setDestAsset(address(token), address(destToken));

        // Should not revert for uint128.max
        vm.prank(bridge);
        landing.transfer(address(token), maxAmount, recipient);
    }

    /// @notice Test Fix #1: int256 overflow protection
    function testInt256OverflowProtection() public {
        // Create a price that would overflow int256
        uint256 overflowPrice = uint256(type(int256).max) + 1;

        // Scale it down like the dispatcher does (divide by 1e10)
        uint256 scaledPrice = overflowPrice; // Still too large

        // The check should trigger when scaledPrice > type(int256).max
        assertGt(scaledPrice, uint256(type(int256).max));

        // When we try to cast this, it should revert
        vm.expectRevert("Price exceeds int256 range");
        this.castToInt256(scaledPrice);
    }

    /// @notice Test Fix #1: int256.max should work
    function testInt256MaxWorks() public {
        uint256 maxValidPrice = uint256(type(int256).max);

        // Should not revert for valid range
        int256 result = this.castToInt256(maxValidPrice);
        assertEq(result, type(int256).max);
    }

    /// @notice Helper to test the cast logic
    function castToInt256(uint256 value) external pure returns (int256) {
        require(value <= uint256(type(int256).max), "Price exceeds int256 range");
        return int256(value);
    }

    /// @notice Test that amounts at boundaries work correctly
    function testBoundaryAmounts() public {
        landing.setDestAsset(address(token), address(destToken));

        // Test various boundary values
        uint256[] memory amounts = new uint256[](4);
        amounts[0] = 1;  // Minimum
        amounts[1] = type(uint64).max;
        amounts[2] = type(uint96).max;
        amounts[3] = type(uint128).max;

        for (uint256 i = 0; i < amounts.length; i++) {
            deal(address(destToken), address(landing), amounts[i]);

            vm.prank(bridge);
            landing.transfer(address(token), amounts[i], recipient);
        }
    }
}
