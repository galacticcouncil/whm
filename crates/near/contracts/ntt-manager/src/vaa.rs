//! VAA body parsing. The core's `verify_vaa` checks signatures and the guardian set but returns only
//! the set index — the body is ours to read, after that call has succeeded.

use crate::messages::{CodecError, Reader};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Vaa {
    pub guardian_set_index: u32,
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
    use near_sdk::serde_json::{self, Value};

    const FIXTURES: &str = include_str!("../tests/fixtures/vaas.json");

    #[test]
    fn parses_the_hydration_header() {
        let all: Value = serde_json::from_str(FIXTURES).unwrap();
        let bytes = hex::decode(all["hydration-prime-to-solana"]["vaa"].as_str().unwrap()).unwrap();
        let vaa = Vaa::parse(&bytes).unwrap();

        // Fixture id: 73/0000…4e7b1e55d2354d4dc6abd876096dc201de0541d1/113
        assert_eq!(vaa.guardian_set_index, 7);
        assert_eq!(vaa.emitter_chain, 73);
        assert_eq!(hex::encode(&vaa.emitter_address[12..]), "4e7b1e55d2354d4dc6abd876096dc201de0541d1");
        assert_eq!(vaa.sequence, 113);
    }

    #[test]
    fn rejects_truncated_signatures() {
        let mut bytes = vec![1, 0, 0, 0, 7, 13];
        bytes.extend_from_slice(&[0u8; 65]);
        assert_eq!(Vaa::parse(&bytes), Err(CodecError::Truncated));
    }
}
