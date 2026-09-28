// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RateLimiter} from "../../../src/psm/lib/RateLimiter.sol";

/// @dev The library holds state, so it needs a frame to live in.
contract RateLimiterHarness {
    using RateLimiter for RateLimiter.Limit;

    RateLimiter.Limit internal limit;

    function set(uint256 capacity, uint256 window) external {
        limit.set(capacity, window);
    }

    function consume(uint256 amount) external {
        limit.consume(amount);
    }

    function tryConsume(uint256 amount) external returns (bool) {
        return limit.tryConsume(amount);
    }

    function available() external view returns (uint256) {
        return limit.available();
    }
}

/// @title RateLimiter
/// @notice A limit that is wrong in the permissive direction is not a limit. Every test here is
///         about the failure being the closed one.
contract RateLimiterTest is Test {
    /// @dev Absolute, and never re-read from `block.timestamp` after a warp: under via-IR solc
    ///      may keep a cached timestamp across an external call, which is sound on-chain and
    ///      false under `vm.warp`. Times here are literals for that reason.
    uint256 internal constant T0 = 365 days;

    RateLimiterHarness internal limiter;

    function setUp() public {
        vm.warp(T0);
        limiter = new RateLimiterHarness();
    }

    // ─── Fail closed ────────────────────────────────────────────

    /// @dev An unset limit is a closed one. Forgetting to configure must not mean unlimited.
    function test_unsetPassesNothing() public view {
        assertEq(limiter.available(), 0);
    }

    function test_unsetRejectsEveryAmount() public {
        vm.expectRevert(abi.encodeWithSelector(RateLimiter.RateLimitExceeded.selector, 1, 0));
        limiter.consume(1);
    }

    function test_zeroCapacityPassesNothing() public {
        limiter.set(0, 1 days);
        assertFalse(limiter.tryConsume(1));
    }

    /// @dev Unlimited exists, but it has to be asked for by name.
    function test_unlimitedIsExplicit() public {
        limiter.set(RateLimiter.UNLIMITED, 0);
        limiter.consume(type(uint128).max);
        assertEq(limiter.available(), RateLimiter.UNLIMITED);
    }

    /// @dev A real capacity with no window would divide by zero on refill.
    function test_rejectsZeroWindow() public {
        vm.expectRevert(RateLimiter.ZeroWindow.selector);
        limiter.set(100, 0);
    }

    // ─── Refill ─────────────────────────────────────────────────

    function test_startsFull() public {
        limiter.set(1_000, 1 days);
        assertEq(limiter.available(), 1_000);
    }

    function test_refillsLinearly() public {
        limiter.set(1_000, 1_000 seconds);
        limiter.consume(1_000);
        assertEq(limiter.available(), 0);

        vm.warp(T0 + 400);
        assertEq(limiter.available(), 400);

        vm.warp(T0 + 10_400);
        assertEq(limiter.available(), 1_000, "never past capacity");
    }

    /// @dev The bug this shape invites: writing the clock on every call discards refill smaller
    ///      than one unit, and a busy limit then refills far slower than its window promises.
    function test_subUnitRefillAccruesAcrossCalls() public {
        limiter.set(100, 1_000 seconds); // 0.1 units per second
        limiter.consume(100);

        for (uint256 i = 1; i <= 9; i++) {
            vm.warp(T0 + i);
            limiter.tryConsume(0);
        }

        vm.warp(T0 + 10);
        assertEq(limiter.available(), 1, "ten seconds is one unit, however often it was touched");
    }

    // ─── Reconfiguration ────────────────────────────────────────

    /// @dev Raising the capacity must not hand over the difference as spendable budget.
    function test_raiseDoesNotGrantRetroactively() public {
        limiter.set(100, 1_000 seconds);
        limiter.consume(100);

        limiter.set(1_000, 1_000 seconds);
        assertEq(limiter.available(), 0, "still spent");
    }

    function test_cutClampsImmediately() public {
        limiter.set(1_000, 1_000 seconds);
        limiter.set(10, 1_000 seconds);
        assertEq(limiter.available(), 10);
    }

    // ─── Consume ────────────────────────────────────────────────

    function test_consumeRevertsWithTheShortfall() public {
        limiter.set(100, 1 days);
        vm.expectRevert(abi.encodeWithSelector(RateLimiter.RateLimitExceeded.selector, 101, 100));
        limiter.consume(101);
    }

    /// @dev The receiving side reports rather than reverts: a message that outruns the limit has
    ///      to queue, or the limit becomes a way to strand an attested transfer.
    function test_tryConsumeReportsInsteadOfReverting() public {
        limiter.set(100, 1 days);
        assertFalse(limiter.tryConsume(101));
        assertEq(limiter.available(), 100, "a refused attempt spends nothing");
        assertTrue(limiter.tryConsume(100));
    }

    /// @dev Sustained throughput is capacity per window. The burst on top is a further capacity,
    ///      which is the number that bounds a single incident — size the parameter against it.
    function test_burstIsOneFurtherCapacity() public {
        limiter.set(1_000, 1_000 seconds);
        limiter.consume(1_000);

        vm.warp(T0 + 1_000);
        limiter.consume(1_000);

        assertEq(limiter.available(), 0, "2000 passed across one window, by construction");
    }

    function testFuzz_neverExceedsCapacity(uint64 capacity, uint32 elapsed) public {
        vm.assume(capacity > 0);
        limiter.set(capacity, 1_000 seconds);
        limiter.consume(capacity);

        vm.warp(T0 + elapsed);
        assertLe(limiter.available(), capacity);
    }
}
