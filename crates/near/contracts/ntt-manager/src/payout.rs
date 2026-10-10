//! Paying tokens out of custody. One path for every way tokens leave — a failed outbound's refund, a
//! cancelled queue entry, an inbound unlock, a claim — so every one of them falls back the same way:
//! a failed `ft_transfer` credits `claimable`, and nothing is ever lost between receipts.
//!
//! A credit may need a new `claimable` entry, and NEAR fails the whole receipt — credit and all —
//! if its storage is not covered. So each one is paid for before it can be needed:
//!
//! - **Unlock** — the `complete` deposit's excess is `Held` until the pay-out settles.
//! - **Claim** — the entry is zeroed, not removed; a transfer that fails again goes back into it.
//! - **Release** — removing the queue entry frees more than any `claimable` entry takes.
//!
//! A failed publish's refund is the exception: `ft_on_transfer` cannot take a deposit, so its entry
//! comes from the contract's free balance.

use near_sdk::json_types::U128;
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, NearToken, Promise, PromiseError};

use crate::{emit, NttManager, NttManagerExt};

pub const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(10);
pub const GAS_FOR_ON_PAID: Gas = Gas::from_tgas(10);
pub const GAS_FOR_REGISTER: Gas = Gas::from_tgas(10);

/// Everything a pay-out consumes, so callers can reserve it inside their own static gas.
pub const GAS_FOR_PAY_OUT: Gas = Gas::from_tgas(20);

/// A pay-out that first registers the recipient's token storage.
pub const GAS_FOR_PAY_OUT_REGISTERING: Gas = Gas::from_tgas(30);

/// A `claimable` entry at its largest — a 64-char account, 125 bytes — with headroom.
pub const CLAIM_RESERVE: NearToken = NearToken::from_millinear(2);

/// A `complete` deposit's excess, held until its pay-out settles: it pays for the `claimable` entry
/// a failed transfer may need, and the rest goes back to `caller`.
#[near(serializers = [json])]
pub struct Held {
    pub caller: AccountId,
    pub amount: U128,
}

#[near(serializers = [json])]
pub struct StorageBalance {
    pub total: U128,
    pub available: U128,
}

#[ext_contract(ext_ft)]
pub trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance;
    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance>;
}

#[near]
impl NttManager {
    /// Pays out an account's claimable balance — what a failed pay-out credited. Stopped by the
    /// pause, like `complete` and `release_inbound`. A failed outbound's refund is not: it only
    /// returns the sender's own tokens.
    #[payable]
    pub fn claim(&mut self) -> Promise {
        near_sdk::assert_one_yocto();
        require!(!self.paused, "Paused");
        let account = env::predecessor_account_id();
        // Zeroed, not removed: a failed transfer goes back into the same entry, with no new storage.
        let amount = self.claimable.get_mut(&account).map(core::mem::take).unwrap_or(0);
        require!(amount > 0, "NothingToClaim");
        self.pay_out(account, amount, None, None)
    }

    /// Settles a pay-out: a failed `ft_transfer` credits `claimable` instead. With `held`, the
    /// storage that credit took comes out of it and the rest is refunded.
    #[private]
    pub fn on_paid(
        &mut self,
        account: AccountId,
        amount: U128,
        held: Option<Held>,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        let storage_before = env::storage_usage();
        if result.is_err() {
            *self.claimable.entry(account.clone()).or_insert(0) += amount.0;
            // `LookupMap` caches until flushed, and storage is only measurable after it.
            self.claimable.flush();
            emit("payout_failed", near_sdk::serde_json::json!({
                "account": account,
                "amount": amount,
            }));
        }

        if let Some(held) = held {
            let storage_cost = env::storage_byte_cost()
                .saturating_mul(env::storage_usage().saturating_sub(storage_before) as u128);
            let refund = NearToken::from_yoctonear(held.amount.0).saturating_sub(storage_cost);
            if !refund.is_zero() {
                let _ = Promise::new(held.caller).transfer(refund);
            }
        }
    }
}

impl NttManager {
    /// `ft_transfer` out of custody, settled by `on_paid`. With `register`, the recipient's token
    /// storage is paid first — `storage_deposit(registration_only)` — from that deposit. Needs
    /// `GAS_FOR_PAY_OUT`, or `GAS_FOR_PAY_OUT_REGISTERING` when registering.
    ///
    /// A failed registration is not special-cased: the `ft_transfer` after it fails, and `on_paid`
    /// credits `claimable`.
    pub(crate) fn pay_out(
        &mut self,
        account: AccountId,
        amount: u128,
        register: Option<NearToken>,
        held: Option<Held>,
    ) -> Promise {
        let transfer = ext_ft::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(account.clone(), U128(amount), None);

        let first = match register {
            Some(deposit) => ext_ft::ext(self.token.clone())
                .with_attached_deposit(deposit)
                .with_static_gas(GAS_FOR_REGISTER)
                .storage_deposit(Some(account.clone()), Some(true))
                .then(transfer),
            None => transfer,
        };

        first.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_ON_PAID)
                .on_paid(account, U128(amount), held),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{contract_with, set_ctx, set_ctx_with, CONTRACT};
    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::get_created_receipts;

    const BOB: &str = "bob.near";
    const RELAYER: &str = "relayer.near";

    /// 3 mN — what a `complete` deposit typically has left once the replay entry is paid.
    const HELD: u128 = 3_000_000_000_000_000_000_000;

    fn held() -> Option<Held> {
        Some(Held { caller: RELAYER.parse().unwrap(), amount: U128(HELD) })
    }

    /// `on_paid` as the contract calls it, for 400 to bob.
    fn paid(c: &mut NttManager, held: Option<Held>, result: Result<(), PromiseError>) {
        set_ctx(CONTRACT, 0);
        c.on_paid(BOB.parse().unwrap(), U128(400), held, result);
    }

    fn claim_as_bob(c: &mut NttManager) {
        set_ctx_with(BOB, 0, 1);
        let _ = c.claim();
    }

    /// Every `Transfer` the last call created to `account`.
    fn transfers_to(account: &str) -> Vec<u128> {
        get_created_receipts()
            .into_iter()
            .filter(|r| r.receiver_id.as_str() == account)
            .flat_map(|r| r.actions)
            .filter_map(|a| match a {
                MockAction::Transfer { deposit, .. } => Some(deposit.as_yoctonear()),
                _ => None,
            })
            .collect()
    }

    fn claimable(c: &NttManager) -> u128 {
        c.claimable_of(BOB.parse().unwrap()).0
    }

    #[test]
    fn a_paid_out_unlock_refunds_all_it_held() {
        let mut c = contract_with(8, 1_000);
        paid(&mut c, held(), Ok(()));
        assert_eq!(transfers_to(RELAYER), vec![HELD]);
        assert_eq!(claimable(&c), 0);
    }

    #[test]
    fn a_failed_unlock_pays_its_entry_from_what_it_held() {
        let mut c = contract_with(8, 1_000);
        paid(&mut c, held(), Err(PromiseError::Failed));
        assert_eq!(claimable(&c), 400);

        let refund = transfers_to(RELAYER)[0];
        assert!(refund < HELD, "the entry was not paid for");
        assert!(refund >= HELD - CLAIM_RESERVE.as_yoctonear(), "more than CLAIM_RESERVE taken");
    }

    #[test]
    fn a_failed_refund_credits_with_nothing_held() {
        let mut c = contract_with(8, 1_000);
        paid(&mut c, None, Err(PromiseError::Failed));
        assert_eq!(claimable(&c), 400);
        assert!(transfers_to(RELAYER).is_empty());
    }

    #[test]
    fn a_failed_claim_goes_back_into_its_entry() {
        let mut c = contract_with(8, 1_000);
        paid(&mut c, None, Err(PromiseError::Failed));
        claim_as_bob(&mut c);
        assert_eq!(claimable(&c), 0);
        // The claim's receipt ends here.
        c.claimable.flush();

        set_ctx(CONTRACT, 0);
        let storage_before = env::storage_usage();
        c.on_paid(BOB.parse().unwrap(), U128(400), None, Err(PromiseError::Failed));
        assert_eq!(env::storage_usage(), storage_before, "a failed claim took new storage");
        assert_eq!(claimable(&c), 400);
    }

    #[test]
    #[should_panic(expected = "NothingToClaim")]
    fn a_claim_in_flight_cannot_be_claimed_again() {
        let mut c = contract_with(8, 1_000);
        paid(&mut c, None, Err(PromiseError::Failed));
        claim_as_bob(&mut c);
        claim_as_bob(&mut c);
    }

    #[test]
    fn a_credit_during_a_claim_is_claimable_on_its_own() {
        let mut c = contract_with(8, 1_000);
        paid(&mut c, None, Err(PromiseError::Failed));
        claim_as_bob(&mut c);
        paid(&mut c, None, Err(PromiseError::Failed));
        assert_eq!(claimable(&c), 400);
        claim_as_bob(&mut c);
        assert_eq!(claimable(&c), 0);
    }
}
