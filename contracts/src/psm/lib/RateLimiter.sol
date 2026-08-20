// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RateLimiter — continuously-refilling budget
/// @notice One limit per direction per contract. Mirrors the shape of the NTT rate limits already
///         running on this route: a bucket of `capacity` that refills linearly over `window`.
///
/// @dev **Fail closed.** A zero capacity passes nothing, and that is the default for an
///      uninitialised limit — an unset limit is a closed one, never an open one. Unlimited exists
///      but must be asked for by name (`UNLIMITED`), so no limit is ever removed by forgetting it.
///
/// @dev **What the bound actually is.** Sustained throughput is `capacity` per `window`. The
///      instantaneous burst is a further `capacity`, because a full bucket can be spent at the
///      start of a window and the refill spent at its end — so the true worst case over an
///      arbitrary window is `2 × capacity`, not `capacity`. Size the parameter against the burst,
///      which is the number that bounds a single incident.
library RateLimiter {
    // ─── Types ──────────────────────────────────────────────────

    struct Limit {
        /// @dev 0 = closed, UNLIMITED = uncapped, anything else = the budget per window.
        uint256 capacity;
        /// @dev Seconds to refill from empty to full.
        uint256 window;
        /// @dev Budget remaining as of `lastUpdate`.
        uint256 level;
        uint256 lastUpdate;
    }

    // ─── Constants ──────────────────────────────────────────────

    /// @notice The explicit opt-out. Never a default.
    uint256 internal constant UNLIMITED = type(uint256).max;

    // ─── Errors ─────────────────────────────────────────────────

    error RateLimitExceeded(uint256 requested, uint256 available);
    error ZeroWindow();

    // ─── Config ─────────────────────────────────────────────────

    /// @notice Set the budget. A raise does not grant the difference retroactively and a cut takes
    ///         effect immediately, so neither direction can be used to mint headroom out of a
    ///         config change.
    function set(Limit storage self, uint256 capacity, uint256 window) internal {
        if (capacity != 0 && capacity != UNLIMITED && window == 0) revert ZeroWindow();

        (uint256 current,) = _sync(self);
        bool fresh = self.lastUpdate == 0;

        self.capacity = capacity;
        self.window = window;
        // A first-time limit starts full: the budget is the whole point of the parameter, and
        // making the operator wait one window for it is a config trap, not a safety property.
        self.level = fresh ? capacity : (current > capacity ? capacity : current);
        self.lastUpdate = block.timestamp;
    }

    // ─── Consume ────────────────────────────────────────────────

    /// @notice Spend from the budget, reverting if it does not cover `amount`.
    function consume(Limit storage self, uint256 amount) internal {
        if (self.capacity == UNLIMITED) return;

        (uint256 current, uint256 stamp) = _sync(self);
        if (amount > current) revert RateLimitExceeded(amount, current);

        self.level = current - amount;
        self.lastUpdate = stamp;
    }

    /// @notice Spend if the budget covers it, reporting rather than reverting.
    /// @dev The receiving side of a corridor uses this: a message that outruns the limit must
    ///      queue, not revert, or the limit becomes a way to strand an attested message.
    function tryConsume(Limit storage self, uint256 amount) internal returns (bool) {
        if (self.capacity == UNLIMITED) return true;

        (uint256 current, uint256 stamp) = _sync(self);
        if (amount > current) return false;

        self.level = current - amount;
        self.lastUpdate = stamp;
        return true;
    }

    // ─── Views ──────────────────────────────────────────────────

    function available(Limit storage self) internal view returns (uint256) {
        if (self.capacity == UNLIMITED) return UNLIMITED;
        (uint256 current,) = _sync(self);
        return current;
    }

    // ─── Internal ───────────────────────────────────────────────

    /// @dev Returns the level as of now, plus the timestamp the caller should store. The two are
    ///      separate because a refill smaller than one unit must NOT advance the clock: writing
    ///      `block.timestamp` on every call would discard the accrued fraction each time, and a
    ///      busy limit would then refill far slower than its window says.
    function _sync(Limit storage self) private view returns (uint256 level, uint256 stamp) {
        uint256 capacity = self.capacity;
        if (capacity == 0 || capacity == UNLIMITED) return (capacity, block.timestamp);

        level = self.level;
        if (level >= capacity) return (capacity, block.timestamp);

        uint256 elapsed = block.timestamp - self.lastUpdate;
        uint256 refilled = (capacity * elapsed) / self.window;
        if (refilled == 0) return (level, self.lastUpdate);

        unchecked {
            uint256 next = level + refilled;
            level = (next < level || next > capacity) ? capacity : next;
        }
        stamp = block.timestamp;
    }
}
