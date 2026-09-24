//! Outbound, NEAR → peer.
//!
//! `ft_on_transfer` locks the tokens and returns only the dust, **immediately**. Publishing is a
//! detached promise. Chaining it into `ft_on_transfer`'s return value would let a failed callback
//! make the token refund the full amount after the message was already published — the guardians
//! sign it, the peer mints, and the sender keeps their tokens too. Detached, the worst a failure can
//! do is leave tokens locked with no message: over-collateralised, never double-minted.
//!
//! No outbound queue: a transfer over the outbound limit reverts, and the token refunds it. A queue
//! entry would be storage the contract pays for — `ft_on_transfer` cannot take a deposit — so anyone
//! could drain the contract's NEAR with dust-sized queued transfers once capacity ran out.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, ext_contract, near, require, AccountId, Gas, Promise, PromiseError, PromiseOrValue};

use crate::messages::{sequence_id, NativeTokenTransfer, NttManagerMessage, TransceiverMessage};
use crate::payout::GAS_FOR_PAY_OUT;
use crate::trimmed::TrimmedAmount;
use crate::{account_hash, emit, now, parse_bytes32, NttManager, NttManagerExt, Peer};

/// The core requires ≥ 10 TGas prepaid on `publish_message`.
pub const GAS_FOR_PUBLISH: Gas = Gas::from_tgas(20);
pub const GAS_FOR_ON_PUBLISHED: Gas = Gas::from_tgas(10);

#[ext_contract(ext_wormhole)]
pub trait WormholeCore {
    fn publish_message(&mut self, data: String, nonce: u32) -> u64;
    /// Verifies signatures and the guardian set; returns the set index. Does not parse the body.
    fn verify_vaa(&self, vaa: String) -> u32;
}

/// `ft_transfer_call`'s `msg`.
#[near(serializers = [json])]
pub struct TransferMsg {
    pub recipient_chain: u16,
    /// Hex: a 20-byte EVM address (left-padded) or a full 32 bytes.
    pub recipient: String,
}

/// A transfer locked on NEAR, carried to `on_published`.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct OutboundTransfer {
    /// `NttManagerMessage.id`, assigned when locked.
    pub id: u64,
    pub sender: AccountId,
    /// Locked, in token units — dust-free, so it untrims exactly.
    pub amount: U128,
    pub trimmed: TrimmedAmount,
    pub recipient_chain: u16,
    pub recipient: [u8; 32],
}

#[near]
impl NttManager {
    /// Called by `config.token` through `ft_transfer_call`. Any panic here makes the token refund the
    /// whole amount, so every rejection is a panic.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token, "UnsupportedToken");
        require!(!self.paused, "Paused");

        let msg: TransferMsg =
            serde_json::from_str(&msg).unwrap_or_else(|_| env::panic_str("InvalidMsg"));
        let peer = self.peer(msg.recipient_chain);
        let recipient = parse_recipient(&msg.recipient);

        let (trimmed, dust) = TrimmedAmount::trim(amount.0, self.token_decimals, peer.decimals)
            .unwrap_or_else(|_| env::panic_str("AmountTooLarge"));
        require!(trimmed.amount > 0, "ZeroAmount");
        let locked = amount.0 - dust;

        let now = now();
        let transfer = OutboundTransfer {
            id: self.next_seq(),
            sender: sender_id,
            amount: U128(locked),
            trimmed,
            recipient_chain: msg.recipient_chain,
            recipient,
        };

        require!(self.outbound.consume(locked, now), "TransferExceedsRateLimit");
        self.inbound_limit(transfer.recipient_chain).backflow(locked, now);

        self.assert_gas(GAS_FOR_PUBLISH.saturating_add(GAS_FOR_ON_PUBLISHED).saturating_add(GAS_FOR_PAY_OUT));
        // Detached — see the module docs. The returned value is only the dust.
        let _ = self.publish(&transfer, &peer).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_ON_PUBLISHED.saturating_add(GAS_FOR_PAY_OUT))
                .on_published(transfer),
        );
        PromiseOrValue::Value(U128(dust))
    }

    /// Settles a direct send: logged on success; on failure the limits are restored and the sender
    /// refunded — tokens are never kept for a message that does not exist.
    #[private]
    pub fn on_published(
        &mut self,
        transfer: OutboundTransfer,
        #[callback_result] result: Result<u64, PromiseError>,
    ) -> Option<Promise> {
        match result {
            Ok(wormhole_sequence) => {
                emit("transfer_sent", sent_json(&transfer, wormhole_sequence));
                None
            }
            Err(_) => {
                let now = now();
                self.outbound.backflow(transfer.amount.0, now);
                self.inbound_limit(transfer.recipient_chain).debit(transfer.amount.0, now);
                emit("transfer_failed", transfer_json(&transfer));
                Some(self.pay_out(transfer.sender, transfer.amount.0, None))
            }
        }
    }
}

impl NttManager {
    fn publish(&self, transfer: &OutboundTransfer, peer: &Peer) -> Promise {
        ext_wormhole::ext(self.core.clone())
            .with_static_gas(GAS_FOR_PUBLISH)
            .publish_message(hex::encode(self.encode_outbound(transfer, peer)), 0)
    }

    /// The Wormhole payload: `TransceiverMessage(NttManagerMessage(NativeTokenTransfer))`.
    pub(crate) fn encode_outbound(&self, transfer: &OutboundTransfer, peer: &Peer) -> Vec<u8> {
        let ntt = NativeTokenTransfer {
            amount: transfer.trimmed,
            source_token: account_hash(&self.token),
            to: transfer.recipient,
            to_chain: transfer.recipient_chain,
            additional_payload: Vec::new(),
        };
        let manager = NttManagerMessage {
            id: sequence_id(transfer.id),
            sender: account_hash(&transfer.sender),
            payload: ntt.encode().unwrap(),
        };
        TransceiverMessage {
            source_manager: account_hash(&env::current_account_id()),
            recipient_manager: peer.manager,
            manager_payload: manager.encode().unwrap(),
            transceiver_payload: Vec::new(),
        }
        .encode()
        .unwrap()
    }

    fn next_seq(&mut self) -> u64 {
        let seq = self.seq;
        self.seq += 1;
        seq
    }

    fn assert_gas(&self, needed: Gas) {
        let left = env::prepaid_gas().saturating_sub(env::used_gas());
        require!(left >= needed, "NotEnoughGas");
    }
}

/// A 20-byte EVM address is left-padded; 32 bytes pass through. Zero is rejected.
fn parse_recipient(value: &str) -> [u8; 32] {
    let bytes = hex::decode(value.trim_start_matches("0x"))
        .unwrap_or_else(|_| env::panic_str("InvalidRecipient"));
    let recipient = match bytes.len() {
        20 => {
            let mut out = [0u8; 32];
            out[12..].copy_from_slice(&bytes);
            out
        }
        32 => parse_bytes32(value),
        _ => env::panic_str("InvalidRecipient"),
    };
    require!(recipient != [0u8; 32], "InvalidRecipient");
    recipient
}

fn transfer_json(transfer: &OutboundTransfer) -> serde_json::Value {
    json!({
        "id": transfer.id,
        "sender": transfer.sender,
        "amount": transfer.amount,
        "recipient_chain": transfer.recipient_chain,
        "recipient": hex::encode(transfer.recipient),
    })
}

fn sent_json(transfer: &OutboundTransfer, wormhole_sequence: u64) -> serde_json::Value {
    let mut value = transfer_json(transfer);
    value["wormhole_sequence"] = json!(wormhole_sequence);
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::TransceiverMessage;
    use crate::tests::{contract_with, set_ctx, CONTRACT, HYDRATION, MANAGER, TOKEN, TRANSCEIVER};
    use near_sdk::test_utils::accounts;

    const RECIPIENT: &str = "0x1111111111111111111111111111111111111111";

    fn msg() -> String {
        json!({ "recipient_chain": HYDRATION, "recipient": RECIPIENT }).to_string()
    }

    /// ZEC-shaped: 8 dp, outbound 1_000, Hydration inbound 1_000.
    fn zec() -> NttManager {
        let mut c = contract_with(8, 1_000);
        c.set_peer(HYDRATION, MANAGER.into(), TRANSCEIVER.into(), 8, U128(1_000));
        set_ctx(TOKEN, 0);
        c
    }

    fn value(r: PromiseOrValue<U128>) -> u128 {
        match r {
            PromiseOrValue::Value(v) => v.0,
            PromiseOrValue::Promise(_) => panic!("expected a value"),
        }
    }

    /// Callbacks are `#[private]`: the contract calls itself.
    fn as_self() {
        set_ctx(CONTRACT, 0);
    }

    #[test]
    fn locks_and_returns_only_the_dust() {
        let mut c = zec();
        assert_eq!(value(c.ft_on_transfer(accounts(1), U128(400), msg())), 0);
        assert_eq!(c.outbound_capacity(), U128(600));
        assert_eq!(c.seq, 1);
    }

    #[test]
    fn near_dust_goes_back() {
        let mut c = contract_with(24, u128::MAX);
        c.set_peer(HYDRATION, MANAGER.into(), TRANSCEIVER.into(), 18, U128(u128::MAX));
        set_ctx(TOKEN, 0);
        // 1.5 NEAR + 1 yocto.
        let amount = 1_500_000_000_000_000_000_000_001u128;
        assert_eq!(value(c.ft_on_transfer(accounts(1), U128(amount), msg())), 1);
    }

    #[test]
    #[should_panic(expected = "UnsupportedToken")]
    fn only_the_configured_token() {
        let mut c = zec();
        set_ctx("wrap.near", 0);
        let _ = c.ft_on_transfer(accounts(1), U128(1), msg());
    }

    #[test]
    #[should_panic(expected = "PeerNotRegistered")]
    fn unknown_chain_is_refunded() {
        let mut c = zec();
        let m = json!({ "recipient_chain": 2, "recipient": RECIPIENT }).to_string();
        let _ = c.ft_on_transfer(accounts(1), U128(1), m);
    }

    #[test]
    #[should_panic(expected = "TransferExceedsRateLimit")]
    fn over_the_limit_is_refunded() {
        let mut c = zec();
        let _ = c.ft_on_transfer(accounts(1), U128(1_001), msg());
    }

    #[test]
    #[should_panic(expected = "Paused")]
    fn paused_is_refunded() {
        let mut c = zec();
        set_ctx(&accounts(0).to_string(), 0);
        c.pause();
        set_ctx(TOKEN, 0);
        let _ = c.ft_on_transfer(accounts(1), U128(1), msg());
    }

    #[test]
    fn published_keeps_the_tokens() {
        let mut c = zec();
        let _ = c.ft_on_transfer(accounts(1), U128(400), msg());
        let transfer = OutboundTransfer {
            id: 0,
            sender: accounts(1),
            amount: U128(400),
            trimmed: TrimmedAmount { amount: 400, decimals: 8 },
            recipient_chain: HYDRATION,
            recipient: parse_recipient(RECIPIENT),
        };

        as_self();
        assert!(c.on_published(transfer, Ok(7)).is_none());
        assert_eq!(c.outbound_capacity(), U128(600));
    }

    #[test]
    fn failed_publish_restores_the_limit_and_refunds() {
        let mut c = zec();
        let _ = c.ft_on_transfer(accounts(1), U128(400), msg());
        let transfer = OutboundTransfer {
            id: 0,
            sender: accounts(1),
            amount: U128(400),
            trimmed: TrimmedAmount { amount: 400, decimals: 8 },
            recipient_chain: HYDRATION,
            recipient: parse_recipient(RECIPIENT),
        };

        as_self();
        assert!(c.on_published(transfer, Err(PromiseError::Failed)).is_some());
        assert_eq!(c.outbound_capacity(), U128(1_000));
    }

    #[test]
    fn payload_is_what_hydration_parses() {
        let c = zec();
        let transfer = OutboundTransfer {
            id: 5,
            sender: accounts(1),
            amount: U128(400),
            trimmed: TrimmedAmount { amount: 400, decimals: 8 },
            recipient_chain: HYDRATION,
            recipient: parse_recipient(RECIPIENT),
        };
        let peer = c.peer(HYDRATION);
        let bytes = c.encode_outbound(&transfer, &peer);

        let tm = TransceiverMessage::parse(&bytes).unwrap();
        assert_eq!(tm.source_manager, env::sha256_array(CONTRACT.as_bytes()));
        assert_eq!(tm.recipient_manager, parse_bytes32(MANAGER));

        let mm = NttManagerMessage::parse(&tm.manager_payload).unwrap();
        assert_eq!(mm.id, sequence_id(5));
        assert_eq!(mm.sender, env::sha256_array(accounts(1).as_bytes()));

        let ntt = NativeTokenTransfer::parse(&mm.payload).unwrap();
        assert_eq!(ntt.amount, TrimmedAmount { amount: 400, decimals: 8 });
        assert_eq!(ntt.source_token, env::sha256_array(TOKEN.as_bytes()));
        assert_eq!(&ntt.to[12..], &hex::decode(&RECIPIENT[2..]).unwrap()[..]);
        assert_eq!(ntt.to_chain, HYDRATION);
    }

    #[test]
    fn recipients_pad_or_pass_through() {
        assert_eq!(&parse_recipient(RECIPIENT)[..12], &[0u8; 12]);
        let full = format!("0x{}", "22".repeat(32));
        assert_eq!(parse_recipient(&full), [0x22; 32]);
    }
}
