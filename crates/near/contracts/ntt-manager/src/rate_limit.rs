//! NTT's rate limiter: a capacity that refills linearly to `limit` over 24 h. Semantics follow
//! `RateLimiter.sol` — consume on send, backflow the opposite direction, limit changes shift the
//! current capacity by the difference.
//!
//! Amounts are in the token's own units, not trimmed: the contract is single-token, so one scale
//! serves every check.

use near_sdk::near;

/// Refill window, seconds.
pub const RATE_LIMIT_DURATION: u64 = 24 * 60 * 60;

#[near(serializers = [borsh])]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RateLimit {
    pub limit: u128,
    capacity: u128,
    last_tx_at: u64,
}

impl RateLimit {
    /// Starts full, as a fresh NTT limit does.
    pub fn new(limit: u128, now: u64) -> Self {
        Self { limit, capacity: limit, last_tx_at: now }
    }

    /// Capacity at `now`, refilled since the last transaction and capped at `limit`.
    pub fn capacity(&self, now: u64) -> u128 {
        let elapsed = now.saturating_sub(self.last_tx_at) as u128;
        let refill = self.limit.saturating_mul(elapsed) / RATE_LIMIT_DURATION as u128;
        self.capacity.saturating_add(refill).min(self.limit)
    }

    /// Takes `amount` out of the window. `false` — and no change — if it does not fit.
    pub fn consume(&mut self, amount: u128, now: u64) -> bool {
        let capacity = self.capacity(now);
        if amount > capacity {
            return false;
        }
        self.capacity = capacity - amount;
        self.last_tx_at = now;
        true
    }

    /// Returns `amount` to the window — the opposite direction's transfer, or a refund.
    pub fn backflow(&mut self, amount: u128, now: u64) {
        self.capacity = self.capacity(now).saturating_add(amount).min(self.limit);
        self.last_tx_at = now;
    }

    /// Moves the limit, shifting the current capacity by the same difference.
    pub fn set_limit(&mut self, limit: u128, now: u64) {
        let capacity = self.capacity(now);
        self.capacity = if limit < self.limit {
            capacity.saturating_sub(self.limit - limit)
        } else {
            capacity + (limit - self.limit)
        };
        self.limit = limit;
        self.last_tx_at = now;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = RATE_LIMIT_DURATION;

    #[test]
    fn consumes_and_refills_linearly() {
        let mut rl = RateLimit::new(1_000, 0);
        assert!(rl.consume(1_000, 0));
        assert_eq!(rl.capacity(0), 0);
        assert_eq!(rl.capacity(DAY / 2), 500);
        assert_eq!(rl.capacity(DAY), 1_000);
        assert_eq!(rl.capacity(DAY * 3), 1_000);
    }

    #[test]
    fn refuses_what_does_not_fit_and_changes_nothing() {
        let mut rl = RateLimit::new(1_000, 0);
        assert!(rl.consume(600, 0));
        let before = rl.clone();
        assert!(!rl.consume(401, 0));
        assert_eq!(rl, before);
    }

    #[test]
    fn backflow_is_capped_at_limit() {
        let mut rl = RateLimit::new(1_000, 0);
        assert!(rl.consume(300, 0));
        rl.backflow(200, 0);
        assert_eq!(rl.capacity(0), 900);
        rl.backflow(500, 0);
        assert_eq!(rl.capacity(0), 1_000);
    }

    #[test]
    fn lowering_the_limit_takes_the_difference_off_capacity() {
        let mut rl = RateLimit::new(1_000, 0);
        assert!(rl.consume(700, 0));
        rl.set_limit(500, 0);
        assert_eq!(rl.capacity(0), 0);
        rl.set_limit(800, 0);
        assert_eq!(rl.capacity(0), 300);
    }
}
