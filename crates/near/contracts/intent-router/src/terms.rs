//! The terms — one action's rules, packed big-endian, hashed into the derivation path. Any change to
//! them derives another account, so nothing here can be altered once funds sit in `A`.
//!
//! ```text
//! field byte widths; the version byte's value is 1 (`LIMIT_SWAP`)
//! version 1 | quoteId 32 | maxSlippageBps 2 | minOutPerIn 16 | minDelivery 16 | deadline 8
//! | recipientKind 1 | refundTo 20 | destAssetLen 1 | destinationAsset D | recipientLen 1 | recipient R
//! ```
//!
//! Checked on the raw bytes, never trusting an encoder: exact length, every field in range. The
//! version byte selects the strategy; the limit swap is the only one.

use near_sdk::{env, AccountId};

use near_common::codec::Reader;

/// The terms version of the limit swap — the only strategy.
pub const LIMIT_SWAP: u8 = 1;

/// Basis points in 1.
pub const BPS: u16 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecipientKind {
    /// Withdrawn off NEAR through POA: `ft_withdraw` to the token contract with a
    /// `WITHDRAW_TO:<recipient>` memo. Needs a `nep141:` asset that POA withdraws this way — the
    /// SDK's to choose; the router checks only that the asset is a NEP-141.
    Withdraw,
    /// Transferred to an account inside `intents.near`.
    Intents,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Terms {
    /// Random per action — keeps one user's actions on separate accounts.
    pub quote_id: [u8; 32],
    /// The floor below the order's oracle rate.
    pub max_slippage_bps: u16,
    /// The user's hard floor, destination units per 1e18 wei. 0 = none.
    pub min_out_per_in: u128,
    /// Before the deadline, deliveries wait until `A` holds this much of the destination asset —
    /// one bridge fee per batch, and never below the bridge's minimum withdrawal. The SDK sets it
    /// from POA's `supported_tokens`. After the deadline any balance is delivered.
    pub min_delivery: u128,
    /// Unix seconds. Swaps end by it; refunds start after it.
    pub deadline: u64,
    pub recipient_kind: RecipientKind,
    /// Ethereum address refunds go to, as native ETH.
    pub refund_to: [u8; 20],
    /// The intents ledger id bought, e.g. `nep141:zec.omft.near`.
    pub destination_asset: String,
    /// Where it goes: an address on its chain, or an intents account.
    pub recipient: String,
}

impl Terms {
    pub fn parse(bytes: &[u8]) -> Result<Self, &'static str> {
        let mut r = Reader::new(bytes);
        if r.u8()? != LIMIT_SWAP {
            return Err("UnknownStrategy");
        }
        let quote_id = r.bytes32()?;
        let max_slippage_bps = r.u16()?;
        let min_out_per_in = r.u128()?;
        let min_delivery = r.u128()?;
        let deadline = r.u64()?;
        let recipient_kind = match r.u8()? {
            0 => RecipientKind::Withdraw,
            1 => RecipientKind::Intents,
            _ => return Err("InvalidRecipientKind"),
        };
        let refund_to = r.bytes20()?;
        let destination_asset = r.string()?;
        let recipient = r.string()?;
        r.finish()?;

        let terms = Self {
            quote_id,
            max_slippage_bps,
            min_out_per_in,
            min_delivery,
            deadline,
            recipient_kind,
            refund_to,
            destination_asset,
            recipient,
        };
        terms.validate()?;
        Ok(terms)
    }

    pub fn encode(&self) -> Result<Vec<u8>, &'static str> {
        self.validate()?;
        let mut out = Vec::with_capacity(98 + self.destination_asset.len() + self.recipient.len());
        out.push(LIMIT_SWAP);
        out.extend_from_slice(&self.quote_id);
        out.extend_from_slice(&self.max_slippage_bps.to_be_bytes());
        out.extend_from_slice(&self.min_out_per_in.to_be_bytes());
        out.extend_from_slice(&self.min_delivery.to_be_bytes());
        out.extend_from_slice(&self.deadline.to_be_bytes());
        out.push(match self.recipient_kind {
            RecipientKind::Withdraw => 0,
            RecipientKind::Intents => 1,
        });
        out.extend_from_slice(&self.refund_to);
        out.push(self.destination_asset.len() as u8);
        out.extend_from_slice(self.destination_asset.as_bytes());
        out.push(self.recipient.len() as u8);
        out.extend_from_slice(self.recipient.as_bytes());
        Ok(out)
    }

    /// The recipient as an intents account, for `recipientKind 1`.
    pub fn recipient_account(&self) -> Option<AccountId> {
        self.recipient.parse().ok()
    }

    /// The destination's NEP-141 contract — `nep141:<contract>` without the prefix.
    pub fn token_contract(&self) -> Option<AccountId> {
        self.destination_asset.strip_prefix("nep141:").and_then(|c| c.parse().ok())
    }

    /// Unix ms.
    pub fn deadline_ms(&self) -> u64 {
        self.deadline.saturating_mul(1_000)
    }

    fn validate(&self) -> Result<(), &'static str> {
        if self.quote_id == [0; 32] {
            return Err("ZeroQuoteId");
        }
        if self.max_slippage_bps >= BPS {
            return Err("InvalidSlippage");
        }
        if self.deadline == 0 {
            return Err("InvalidDeadline");
        }
        if self.refund_to == [0; 20] {
            return Err("ZeroRefundTo");
        }
        if !printable(&self.destination_asset) {
            return Err("InvalidDestinationAsset");
        }
        // It ends up in a withdrawal memo or as an account id: no spaces, no control characters.
        // Only structure is checked here, all of which the Solidity encoder mirrors: terms the
        // encoder accepts must parse, or their ETH could not even refund. Whether the recipient is
        // deliverable — an account id, a NEP-141 to withdraw — is checked at swap and delivery.
        if !printable(&self.recipient) {
            return Err("InvalidRecipient");
        }
        Ok(())
    }
}

/// `keccak256` of the encoded terms — the derivation path, and the order message's `authPath`.
pub fn auth_path(encoded: &[u8]) -> [u8; 32] {
    env::keccak256_array(encoded)
}

/// The path string `v1.signer` derives from: `0x` + lowercase hex. Frozen — another spelling is
/// another account.
pub fn path_string(path: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(path))
}

/// 1..=255 bytes, every one visible ASCII.
fn printable(s: &str) -> bool {
    (1..=255).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_graphic())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) const ZEC: &str = "nep141:zec.omft.near";
    pub(crate) const T_ADDR: &str = "t1KPVSRgnFHPBWMJLC7taJioN6m5Q6jVBma";

    pub(crate) fn sample() -> Terms {
        Terms {
            quote_id: [0x11; 32],
            max_slippage_bps: 100,
            min_out_per_in: 150_000_000,
            min_delivery: 1_000_000,
            deadline: 1_800_000_000,
            recipient_kind: RecipientKind::Withdraw,
            refund_to: [0x22; 20],
            destination_asset: ZEC.into(),
            recipient: T_ADDR.into(),
        }
    }

    #[test]
    fn round_trips() {
        let t = sample();
        let bytes = t.encode().unwrap();
        assert_eq!(bytes.len(), 98 + ZEC.len() + T_ADDR.len());
        assert_eq!(Terms::parse(&bytes).unwrap(), t);
    }

    /// Byte layout, field by field — the vector the Solidity codec must reproduce.
    #[test]
    fn layout() {
        let bytes = sample().encode().unwrap();
        assert_eq!(bytes[0], LIMIT_SWAP);
        assert_eq!(&bytes[1..33], &[0x11; 32]);
        assert_eq!(&bytes[33..35], &100u16.to_be_bytes());
        assert_eq!(&bytes[35..51], &150_000_000u128.to_be_bytes());
        assert_eq!(&bytes[51..67], &1_000_000u128.to_be_bytes());
        assert_eq!(&bytes[67..75], &1_800_000_000u64.to_be_bytes());
        assert_eq!(bytes[75], 0);
        assert_eq!(&bytes[76..96], &[0x22; 20]);
        assert_eq!(bytes[96] as usize, ZEC.len());
        assert_eq!(&bytes[97..97 + ZEC.len()], ZEC.as_bytes());
        assert_eq!(bytes[97 + ZEC.len()] as usize, T_ADDR.len());
    }

    /// The same terms from `scripts/intent-router/shared.ts`'s `encodeTerms`, and their keccak.
    #[test]
    fn matches_the_typescript_encoder() {
        let bytes = sample().encode().unwrap();
        assert_eq!(
            hex::encode(&bytes),
            "011111111111111111111111111111111111111111111111111111111111111111006400000000000000000000000008f0d1\
             80000000000000000000000000000f4240000000006b49d200002222222222222222222222222222222222222222146e6570\
             3134313a7a65632e6f6d66742e6e6561722374314b50565352676e46485042574d4a4c433774614a696f4e366d3551366a56\
             426d61"
        );
        assert_eq!(
            path_string(&auth_path(&bytes)),
            "0xa2159833cf7701b9e372725c6e640f1e922752118b6e5087dedbbb89b7a6d193"
        );
    }

    #[test]
    fn path_is_keccak_in_0x_hex() {
        let bytes = sample().encode().unwrap();
        let path = auth_path(&bytes);
        assert_eq!(path, env::keccak256_array(&bytes));
        assert_eq!(path_string(&path), format!("0x{}", hex::encode(path)));
    }

    #[test]
    fn rejects_bad_bytes() {
        let bytes = sample().encode().unwrap();

        let mut other = bytes.clone();
        other[0] = 2;
        assert_eq!(Terms::parse(&other), Err("UnknownStrategy"));

        let mut long = bytes.clone();
        long.push(0);
        assert_eq!(Terms::parse(&long), Err("TrailingBytes"));

        assert_eq!(Terms::parse(&bytes[..bytes.len() - 1]), Err("Truncated"));

        let mut kind = bytes.clone();
        kind[75] = 2;
        assert_eq!(Terms::parse(&kind), Err("InvalidRecipientKind"));
    }

    #[test]
    fn rejects_bad_fields() {
        let check = |f: fn(&mut Terms), err: &str| {
            let mut t = sample();
            f(&mut t);
            assert_eq!(t.encode(), Err(err));
        };
        check(|t| t.quote_id = [0; 32], "ZeroQuoteId");
        check(|t| t.max_slippage_bps = BPS, "InvalidSlippage");
        check(|t| t.deadline = 0, "InvalidDeadline");
        check(|t| t.refund_to = [0; 20], "ZeroRefundTo");
        check(|t| t.destination_asset = String::new(), "InvalidDestinationAsset");
        check(|t| t.recipient = "t1 x".into(), "InvalidRecipient");
        check(|t| t.recipient = "a".repeat(256), "InvalidRecipient");

    }

    #[test]
    fn intents_recipient_is_an_account() {
        let mut t = sample();
        t.recipient_kind = RecipientKind::Intents;
        t.recipient = "alice.near".into();
        assert_eq!(Terms::parse(&t.encode().unwrap()).unwrap().recipient, "alice.near");
    }

    #[test]
    fn any_change_moves_the_path() {
        let base = auth_path(&sample().encode().unwrap());
        let mut t = sample();
        t.recipient = "t1KPVSRgnFHPBWMJLC7taJioN6m5Q6jVBmb".into();
        assert_ne!(auth_path(&t.encode().unwrap()), base);
        let mut t = sample();
        t.refund_to[19] ^= 1;
        assert_ne!(auth_path(&t.encode().unwrap()), base);
    }
}
