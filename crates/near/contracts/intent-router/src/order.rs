//! The order message — one per execution, published by `IntentQuoteEmitter` on Hydration with the
//! oracle rate the swap must clear.
//!
//! ```text
//! msgType 1 (ORDER) | authPath 32 | seq 8 | amount 16 | outPerIn 16        73 bytes
//! ```

use crate::codec::Reader;

pub const ORDER: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Order {
    /// `keccak256(terms)` — computed by the emitter, so the rate is bound to the terms' asset.
    pub auth_path: [u8; 32],
    /// The NTT manager sequence of the order — its id.
    pub seq: u64,
    /// WETH the order sent, wei.
    pub amount: u128,
    /// Destination smallest units per 1e18 wei, before slippage.
    pub out_per_in: u128,
}

impl Order {
    pub fn parse(payload: &[u8]) -> Result<Self, &'static str> {
        let mut r = Reader::new(payload);
        if r.u8()? != ORDER {
            return Err("NotAnOrder");
        }
        let auth_path = r.bytes32()?;
        let seq = r.u64()?;
        let amount = r.u128()?;
        let out_per_in = r.u128()?;
        r.finish()?;
        if out_per_in == 0 {
            return Err("ZeroRate");
        }
        Ok(Self { auth_path, seq, amount, out_per_in })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(73);
        out.push(ORDER);
        out.extend_from_slice(&self.auth_path);
        out.extend_from_slice(&self.seq.to_be_bytes());
        out.extend_from_slice(&self.amount.to_be_bytes());
        out.extend_from_slice(&self.out_per_in.to_be_bytes());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Order {
        Order { auth_path: [7; 32], seq: 9, amount: 10u128.pow(15), out_per_in: 180_000_000 }
    }

    #[test]
    fn round_trips_in_73_bytes() {
        let bytes = sample().encode();
        assert_eq!(bytes.len(), 73);
        assert_eq!(Order::parse(&bytes).unwrap(), sample());
    }

    #[test]
    fn rejects_bad_payloads() {
        let bytes = sample().encode();
        let mut other = bytes.clone();
        other[0] = 2;
        assert_eq!(Order::parse(&other), Err("NotAnOrder"));
        assert_eq!(Order::parse(&bytes[..72]), Err("Truncated"));
        let mut long = bytes.clone();
        long.push(0);
        assert_eq!(Order::parse(&long), Err("TrailingBytes"));
        let zero = Order { out_per_in: 0, ..sample() }.encode();
        assert_eq!(Order::parse(&zero), Err("ZeroRate"));
    }
}
