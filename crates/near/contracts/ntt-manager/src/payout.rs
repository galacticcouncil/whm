//! Paying tokens out of custody. One path for every way tokens leave — a failed outbound's refund, a
//! cancelled queue entry, an inbound unlock, a claim — so every one of them falls back the same way:
//! a failed `ft_transfer` credits `claimable`, and nothing is ever lost between receipts.

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
    /// Pays out an account's claimable balance — what a failed pay-out credited.
    #[payable]
    pub fn claim(&mut self) -> Promise {
        near_sdk::assert_one_yocto();
        let account = env::predecessor_account_id();
        let amount = self.claimable.remove(&account).unwrap_or(0);
        require!(amount > 0, "NothingToClaim");
        self.pay_out(account, amount, None)
    }

    /// Settles a pay-out: a failed `ft_transfer` credits `claimable` instead.
    #[private]
    pub fn on_paid(
        &mut self,
        account: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_err() {
            *self.claimable.entry(account.clone()).or_insert(0) += amount.0;
            emit("payout_failed", near_sdk::serde_json::json!({
                "account": account,
                "amount": amount,
            }));
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
                .on_paid(account, U128(amount)),
        )
    }
}
