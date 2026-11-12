//! Wormhole VAAs. The core's `verify_vaa` checks signatures and the guardian set but returns only
//! the set index — the body is ours to read, after that call has succeeded.

use near_sdk::ext_contract;

use crate::codec::{CodecError, Reader};

#[ext_contract(ext_wormhole)]
pub trait WormholeCore {
    /// The core requires ≥ 10 TGas prepaid.
    fn publish_message(&mut self, data: String, nonce: u32) -> u64;
    /// Verifies signatures and the guardian set; returns the set index. Does not parse the body.
    fn verify_vaa(&self, vaa: String) -> u32;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Vaa {
    pub guardian_set_index: u32,
    /// Seconds — the source block's time.
    pub timestamp: u32,
    pub nonce: u32,
    pub emitter_chain: u16,
    pub emitter_address: [u8; 32],
    pub sequence: u64,
    pub consistency_level: u8,
    pub payload: Vec<u8>,
}

/// Bytes per signature: guardian index + 65-byte secp256k1 signature.
const SIGNATURE_LEN: usize = 66;

impl Vaa {
    pub fn parse(encoded: &[u8]) -> Result<Self, CodecError> {
        let mut r = Reader::new(encoded);
        let version = r.u8()?;
        if version != 1 {
            return Err(CodecError::InvalidPrefix([version, 0, 0, 0]));
        }
        let guardian_set_index = r.u32()?;
        let signatures = r.u8()? as usize;
        r.take(signatures * SIGNATURE_LEN)?;

        let timestamp = r.u32()?;
        let nonce = r.u32()?;
        let emitter_chain = r.u16()?;
        let emitter_address = r.bytes32()?;
        let sequence = r.u64()?;
        let consistency_level = r.u8()?;
        let payload = r.rest().to_vec();

        Ok(Self {
            guardian_set_index,
            timestamp,
            nonce,
            emitter_chain,
            emitter_address,
            sequence,
            consistency_level,
            payload,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A VAA envelope with no signatures — enough for parsing; only the core verifies.
    fn envelope(version: u8) -> Vec<u8> {
        let mut out = vec![version];
        out.extend_from_slice(&5u32.to_be_bytes());
        out.push(0);
        out.extend_from_slice(&1_700_000_000u32.to_be_bytes());
        out.extend_from_slice(&0u32.to_be_bytes());
        out.extend_from_slice(&73u16.to_be_bytes());
        out.extend_from_slice(&[9; 32]);
        out.extend_from_slice(&42u64.to_be_bytes());
        out.push(202);
        out.extend_from_slice(&[1, 2, 3]);
        out
    }

    #[test]
    fn parses_the_envelope() {
        let vaa = Vaa::parse(&envelope(1)).unwrap();
        assert_eq!(vaa.guardian_set_index, 5);
        assert_eq!(vaa.timestamp, 1_700_000_000);
        assert_eq!(vaa.emitter_chain, 73);
        assert_eq!(vaa.emitter_address, [9; 32]);
        assert_eq!(vaa.sequence, 42);
        assert_eq!(vaa.consistency_level, 202);
        assert_eq!(vaa.payload, vec![1, 2, 3]);
    }

    #[test]
    fn rejects_truncated_signatures() {
        let mut bytes = vec![1, 0, 0, 0, 7, 13];
        bytes.extend_from_slice(&[0u8; 65]);
        assert_eq!(Vaa::parse(&bytes), Err(CodecError::Truncated));
    }

    #[test]
    fn rejects_another_version() {
        assert_eq!(Vaa::parse(&envelope(2)), Err(CodecError::InvalidPrefix([2, 0, 0, 0])));
    }
}
