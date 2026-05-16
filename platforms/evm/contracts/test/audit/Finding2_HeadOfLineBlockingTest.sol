// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {BasejumpLanding} from "../../src/BasejumpLanding.sol";
import {IBasejumpLanding} from "../../src/interfaces/IBasejumpLanding.sol";

/// @dev Minimal ERC20 with mint
contract MockERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @title Finding2_HeadOfLineBlockingTest
/// @notice Demonstrates that a single large pending transfer blocks all
///         subsequent smaller transfers, and verifies the fix allows
///         out-of-order fulfillment and owner skip.
contract Finding2_HeadOfLineBlockingTest is Test {

    BasejumpLanding public landing;
    MockERC20 public usdc;

    address public bridge = makeAddr("authorizedBridge");

    bytes32 public recipientA = bytes32(uint256(uint160(makeAddr("recipientA"))));
    bytes32 public recipientB = bytes32(uint256(uint160(makeAddr("recipientB"))));
    bytes32 public recipientC = bytes32(uint256(uint160(makeAddr("recipientC"))));

    address constant DISPATCH_PRECOMPILE = 0x0000000000000000000000000000000000000401;

    function setUp() public {
        // Deploy Landing behind UUPS proxy
        BasejumpLanding impl = new BasejumpLanding();
        landing = BasejumpLanding(address(new ERC1967Proxy(
            address(impl), abi.encodeCall(BasejumpLanding.initialize, ())
        )));

        usdc = new MockERC20();
        landing.setAuthorizedBridge(bridge, true);
        landing.setDestAsset(address(usdc), address(usdc));

        // Pool starts EMPTY - all transfers will queue
        // Mock dispatch precompile
        vm.mockCall(DISPATCH_PRECOMPILE, bytes(""), bytes(""));
    }

    /// @dev Queue a transfer (will always queue since pool is empty)
    function _queue(uint256 amount, bytes32 recipient) internal {
        vm.prank(bridge);
        landing.transfer(address(usdc), amount, recipient);
    }

    // ═══════════════════════════════════════════════════════════════
    // EXPLOIT: Head-of-Line Blocking
    // ═══════════════════════════════════════════════════════════════

    /// @notice A single large transfer at queue head permanently blocks
    ///         all smaller transfers behind it.
    function test_exploit_headOfLineBlocking() public {
        // ─── Queue 3 transfers (pool is empty, all queue) ─────────
        _queue(1_000_000e6, recipientA);   // id=0: huge (1M USDC)
        _queue(100e6, recipientB);          // id=1: small (100 USDC)
        _queue(200e6, recipientC);          // id=2: small (200 USDC)

        assertEq(landing.pendingHead(), 0);
        assertEq(landing.pendingTail(), 3);

        // ─── Add enough liquidity for the small transfers ─────────
        usdc.mint(address(landing), 10_000e6);
        console.log("Pool balance:", usdc.balanceOf(address(landing)));

        // ─── fulfillPending always tries head (1M) - REVERTS ──────
        vm.expectRevert(IBasejumpLanding.InsufficientBalance.selector);
        landing.fulfillPending();

        // ─── Small transfers are stuck ────────────────────────────
        (, uint256 amountB,) = landing.pendingTransfers(1);
        (, uint256 amountC,) = landing.pendingTransfers(2);
        assertEq(amountB, 100e6, "100 USDC transfer stuck");
        assertEq(amountC, 200e6, "200 USDC transfer stuck");

        console.log("EXPLOIT CONFIRMED: Pool has 10,000 USDC but cannot fulfill 100 or 200 USDC transfers");
        console.log("  Reason: 1,000,000 USDC entry at head blocks everything");
    }

    // ═══════════════════════════════════════════════════════════════
    // FIX: Out-of-Order Fulfillment
    // ═══════════════════════════════════════════════════════════════

    /// @notice fix_fulfillPending(id) bypasses the stuck head entry
    ///         to fulfill smaller transfers by ID.
    function test_fix_outOfOrderFulfillment() public {
        // Same queue setup
        _queue(1_000_000e6, recipientA);   // id=0: stuck
        _queue(100e6, recipientB);          // id=1
        _queue(200e6, recipientC);          // id=2

        usdc.mint(address(landing), 10_000e6);

        // Original still blocked
        vm.expectRevert(IBasejumpLanding.InsufficientBalance.selector);
        landing.fulfillPending();

        // ─── Fix: fulfill by ID, skip the head ────────────────────
        vm.expectEmit(true, true, false, true, address(landing));
        emit IBasejumpLanding.PendingTransferFulfilled(1, address(usdc), address(usdc), recipientB, 100e6);
        landing.fix_fulfillPending(1);

        vm.expectEmit(true, true, false, true, address(landing));
        emit IBasejumpLanding.PendingTransferFulfilled(2, address(usdc), address(usdc), recipientC, 200e6);
        landing.fix_fulfillPending(2);

        // Small transfers fulfilled
        (, uint256 amountB,) = landing.pendingTransfers(1);
        (, uint256 amountC,) = landing.pendingTransfers(2);
        assertEq(amountB, 0, "100 USDC fulfilled");
        assertEq(amountC, 0, "200 USDC fulfilled");

        // Huge transfer still queued
        (, uint256 amountA,) = landing.pendingTransfers(0);
        assertEq(amountA, 1_000_000e6, "Huge transfer still in queue");

        // Head hasn't moved (slot 0 still occupied)
        assertEq(landing.pendingHead(), 0, "Head stays at stuck entry");

        console.log("FIX VERIFIED: Small transfers fulfilled despite stuck head");
    }

    /// @notice Owner can skip a permanently stuck entry to unblock the FIFO path.
    function test_fix_skipPending() public {
        _queue(1_000_000e6, recipientA);   // id=0: stuck
        _queue(100e6, recipientB);          // id=1

        usdc.mint(address(landing), 10_000e6);

        // FIFO blocked
        vm.expectRevert(IBasejumpLanding.InsufficientBalance.selector);
        landing.fulfillPending();

        // ─── Owner skips the stuck entry ──────────────────────────
        landing.fix_skipPending(0);

        // Head auto-advances past the deleted slot to id=1
        assertEq(landing.pendingHead(), 1, "Head advanced past skipped entry");

        // Now original fulfillPending works on id=1
        landing.fulfillPending();

        (, uint256 amountB,) = landing.pendingTransfers(1);
        assertEq(amountB, 0, "Small transfer fulfilled after skip");

        console.log("FIX VERIFIED: Owner skipped stuck entry, FIFO unblocked");
    }

    /// @notice fix_skipPending is owner-only.
    function test_fix_skipPendingOnlyOwner() public {
        _queue(100e6, recipientA);

        vm.prank(makeAddr("attacker"));
        vm.expectRevert(IBasejumpLanding.NotOwner.selector);
        landing.fix_skipPending(0);
    }

    /// @notice fix_fulfillPending rejects invalid IDs.
    function test_fix_fulfillPendingInvalidId() public {
        vm.expectRevert("Invalid pending ID");
        landing.fix_fulfillPending(999);
    }

    /// @notice fix_fulfillPending rejects already-fulfilled entries.
    function test_fix_fulfillPendingAlreadyFulfilled() public {
        _queue(100e6, recipientA);   // id=0
        _queue(200e6, recipientB);   // id=1
        usdc.mint(address(landing), 10_000e6);

        // Fulfill id=1 (not head) — head stays at 0
        landing.fix_fulfillPending(1);

        // Try to fulfill id=1 again — already cleared
        vm.expectRevert("Already fulfilled or empty");
        landing.fix_fulfillPending(1);
    }

    /// @notice Head auto-advances past consecutive empty slots.
    function test_fix_headAutoAdvances() public {
        _queue(100e6, recipientA);   // id=0
        _queue(200e6, recipientB);   // id=1
        _queue(300e6, recipientC);   // id=2

        usdc.mint(address(landing), 10_000e6);

        // Fulfill 0 and 1 out of order
        landing.fix_fulfillPending(0);
        // After fulfilling head (0), head advances. If slot 1 is still occupied, stops at 1.
        assertEq(landing.pendingHead(), 1, "Head advanced to 1");

        landing.fix_fulfillPending(1);
        // After fulfilling 1, head advances past consecutive empty 1 to 2
        assertEq(landing.pendingHead(), 2, "Head auto-advanced past empty slots to 2");
    }
}
