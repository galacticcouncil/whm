//! NTT wire format — byte-for-byte `TransceiverStructs.sol`, so the Hydration side parses what this
//! contract publishes, and this contract parses what Hydration publishes, with neither changed.

use crate::trimmed::TrimmedAmount;

/// The Wormhole transceiver's payload prefix.
pub const WH_TRANSCEIVER_PAYLOAD_PREFIX: [u8; 4] = [0x99, 0x45, 0xFF, 0x10];

/// The `NativeTokenTransfer` prefix, inside the manager's message.
pub const NTT_PREFIX: [u8; 4] = [0x99, 0x4E, 0x54, 0x54];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodecError {
    Truncated,
    TrailingBytes,
    InvalidPrefix([u8; 4]),
    PayloadTooLong,
}

/// Emitted and received by the transceiver; wraps the manager's message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransceiverMessage {
    pub source_manager: [u8; 32],
    pub recipient_manager: [u8; 32],
    pub manager_payload: Vec<u8>,
    pub transceiver_payload: Vec<u8>,
}

/// Emitted and received by the manager; `payload` is a `NativeTokenTransfer`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NttManagerMessage {
    /// EVM assigns it incrementally; NTT does not require that elsewhere. Here: `seq`, big-endian,
    /// left-padded — the same shape EVM writes.
    pub id: [u8; 32],
    pub sender: [u8; 32],
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeTokenTransfer {
    pub amount: TrimmedAmount,
    pub source_token: [u8; 32],
    pub to: [u8; 32],
    pub to_chain: u16,
    /// Optional on the wire: encoded only when non-empty, as on EVM.
    pub additional_payload: Vec<u8>,
}

impl TransceiverMessage {
    pub fn encode(&self) -> Result<Vec<u8>, CodecError> {
        let mut out = Vec::with_capacity(4 + 32 + 32 + 2 + self.manager_payload.len() + 2);
        out.extend_from_slice(&WH_TRANSCEIVER_PAYLOAD_PREFIX);
        out.extend_from_slice(&self.source_manager);
        out.extend_from_slice(&self.recipient_manager);
        put_prefixed(&mut out, &self.manager_payload)?;
        put_prefixed(&mut out, &self.transceiver_payload)?;
        Ok(out)
    }

    pub fn parse(encoded: &[u8]) -> Result<Self, CodecError> {
        let mut r = Reader::new(encoded);
        let prefix = r.bytes4()?;
        if prefix != WH_TRANSCEIVER_PAYLOAD_PREFIX {
            return Err(CodecError::InvalidPrefix(prefix));
        }
        let source_manager = r.bytes32()?;
        let recipient_manager = r.bytes32()?;
        let manager_payload = r.prefixed()?;
        let transceiver_payload = r.prefixed()?;
        r.finish()?;
        Ok(Self { source_manager, recipient_manager, manager_payload, transceiver_payload })
    }
}

impl NttManagerMessage {
    pub fn encode(&self) -> Result<Vec<u8>, CodecError> {
        let mut out = Vec::with_capacity(32 + 32 + 2 + self.payload.len());
        out.extend_from_slice(&self.id);
        out.extend_from_slice(&self.sender);
        put_prefixed(&mut out, &self.payload)?;
        Ok(out)
    }

    pub fn parse(encoded: &[u8]) -> Result<Self, CodecError> {
        let mut r = Reader::new(encoded);
        let id = r.bytes32()?;
        let sender = r.bytes32()?;
        let payload = r.prefixed()?;
        r.finish()?;
        Ok(Self { id, sender, payload })
    }
}

impl NativeTokenTransfer {
    pub fn encode(&self) -> Result<Vec<u8>, CodecError> {
        let mut out = Vec::with_capacity(4 + 1 + 8 + 32 + 32 + 2);
        out.extend_from_slice(&NTT_PREFIX);
        // Decimals before amount — the reverse of the Solidity type's field order, matching Rust NTT.
        out.push(self.amount.decimals);
        out.extend_from_slice(&self.amount.amount.to_be_bytes());
        out.extend_from_slice(&self.source_token);
        out.extend_from_slice(&self.to);
        out.extend_from_slice(&self.to_chain.to_be_bytes());
        if !self.additional_payload.is_empty() {
            put_prefixed(&mut out, &self.additional_payload)?;
        }
        Ok(out)
    }

    pub fn parse(encoded: &[u8]) -> Result<Self, CodecError> {
        let mut r = Reader::new(encoded);
        let prefix = r.bytes4()?;
        if prefix != NTT_PREFIX {
            return Err(CodecError::InvalidPrefix(prefix));
        }
        let decimals = r.u8()?;
        let amount = r.u64()?;
        let source_token = r.bytes32()?;
        let to = r.bytes32()?;
        let to_chain = r.u16()?;
        let additional_payload = if r.is_empty() { Vec::new() } else { r.prefixed()? };
        r.finish()?;
        Ok(Self {
            amount: TrimmedAmount { amount, decimals },
            source_token,
            to,
            to_chain,
            additional_payload,
        })
    }
}

/// NTT's replay key: `keccak256(sourceChainId ‖ encodedNttManagerMessage)`, as on EVM.
pub fn manager_message_digest(source_chain: u16, encoded_manager_message: &[u8]) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(2 + encoded_manager_message.len());
    preimage.extend_from_slice(&source_chain.to_be_bytes());
    preimage.extend_from_slice(encoded_manager_message);
    near_sdk::env::keccak256_array(&preimage)
}

/// Left-pads a sequence into a manager message id — `bytes32(uint256(sequence))` on EVM.
pub fn sequence_id(seq: u64) -> [u8; 32] {
    let mut id = [0u8; 32];
    id[24..].copy_from_slice(&seq.to_be_bytes());
    id
}

fn put_prefixed(out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), CodecError> {
    let len = u16::try_from(bytes.len()).map_err(|_| CodecError::PayloadTooLong)?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}

/// Big-endian cursor. Every read is checked; `finish` rejects trailing bytes, as `checkLength`
/// does on EVM.
pub(crate) struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    pub(crate) fn take(&mut self, n: usize) -> Result<&'a [u8], CodecError> {
        let end = self.pos.checked_add(n).ok_or(CodecError::Truncated)?;
        let slice = self.buf.get(self.pos..end).ok_or(CodecError::Truncated)?;
        self.pos = end;
        Ok(slice)
    }

    pub(crate) fn u8(&mut self) -> Result<u8, CodecError> {
        Ok(self.take(1)?[0])
    }

    pub(crate) fn u16(&mut self) -> Result<u16, CodecError> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }

    pub(crate) fn u32(&mut self) -> Result<u32, CodecError> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }

    pub(crate) fn u64(&mut self) -> Result<u64, CodecError> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }

    pub(crate) fn bytes4(&mut self) -> Result<[u8; 4], CodecError> {
        Ok(self.take(4)?.try_into().unwrap())
    }

    pub(crate) fn bytes32(&mut self) -> Result<[u8; 32], CodecError> {
        Ok(self.take(32)?.try_into().unwrap())
    }

    fn prefixed(&mut self) -> Result<Vec<u8>, CodecError> {
        let len = self.u16()? as usize;
        Ok(self.take(len)?.to_vec())
    }

    pub(crate) fn rest(&mut self) -> &'a [u8] {
        let rest = &self.buf[self.pos..];
        self.pos = self.buf.len();
        rest
    }

    fn is_empty(&self) -> bool {
        self.pos == self.buf.len()
    }

    fn finish(&self) -> Result<(), CodecError> {
        if self.is_empty() {
            Ok(())
        } else {
            Err(CodecError::TrailingBytes)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vaa::Vaa;
    use near_sdk::serde_json::{self, Value};

    const FIXTURES: &str = include_str!("../tests/fixtures/vaas.json");

    fn fixture(label: &str) -> Vec<u8> {
        let all: Value = serde_json::from_str(FIXTURES).unwrap();
        hex::decode(all[label]["vaa"].as_str().unwrap()).unwrap()
    }

    fn pad20(hex_addr: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        out[12..].copy_from_slice(&hex::decode(hex_addr.trim_start_matches("0x")).unwrap());
        out
    }

    /// Parse every layer of a real EVM-encoded VAA, then re-encode each and demand the same bytes.
    fn round_trip(label: &str) -> (Vaa, TransceiverMessage, NttManagerMessage, NativeTokenTransfer) {
        let vaa = Vaa::parse(&fixture(label)).unwrap();

        let tm = TransceiverMessage::parse(&vaa.payload).unwrap();
        assert_eq!(tm.encode().unwrap(), vaa.payload, "{label}: transceiver message");

        let mm = NttManagerMessage::parse(&tm.manager_payload).unwrap();
        assert_eq!(mm.encode().unwrap(), tm.manager_payload, "{label}: manager message");

        let ntt = NativeTokenTransfer::parse(&mm.payload).unwrap();
        assert_eq!(ntt.encode().unwrap(), mm.payload, "{label}: native token transfer");

        (vaa, tm, mm, ntt)
    }

    #[test]
    fn ethereum_usdc_to_hydration() {
        let (vaa, tm, _, ntt) = round_trip("ethereum-usdc-to-hydration");
        assert_eq!(vaa.emitter_chain, 2);
        assert_eq!(tm.recipient_manager, pad20("0xEcEab64542A875C4472671D9Ed1E690cdD4e28fC"));
        assert_eq!(ntt.source_token, pad20("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"));
        assert_eq!(ntt.to_chain, 73);
        assert_eq!(ntt.amount.decimals, 6);
        assert!(tm.transceiver_payload.is_empty());
        assert!(ntt.additional_payload.is_empty());
    }

    #[test]
    fn hydration_prime_to_solana() {
        let (vaa, tm, _, ntt) = round_trip("hydration-prime-to-solana");
        assert_eq!(vaa.emitter_chain, 73);
        assert_eq!(tm.source_manager, pad20("0xFCaF4aA069C565d25539028970703F01e47D3E0B"));
        assert_eq!(ntt.to_chain, 1);
    }

    #[test]
    fn evm_ids_are_left_padded_sequences() {
        let (_, _, mm, _) = round_trip("ethereum-usdc-to-hydration");
        assert!(mm.id[..24].iter().all(|b| *b == 0));
        let seq = u64::from_be_bytes(mm.id[24..].try_into().unwrap());
        assert_eq!(sequence_id(seq), mm.id);
    }

    #[test]
    fn additional_payload_is_optional_on_the_wire() {
        let mut ntt = NativeTokenTransfer {
            amount: TrimmedAmount { amount: 1, decimals: 8 },
            source_token: [1; 32],
            to: [2; 32],
            to_chain: 73,
            additional_payload: Vec::new(),
        };
        assert_eq!(ntt.encode().unwrap().len(), 4 + 1 + 8 + 32 + 32 + 2);

        ntt.additional_payload = vec![0xAB; 3];
        let encoded = ntt.encode().unwrap();
        assert_eq!(encoded.len(), 4 + 1 + 8 + 32 + 32 + 2 + 2 + 3);
        assert_eq!(NativeTokenTransfer::parse(&encoded).unwrap(), ntt);
    }

    #[test]
    fn rejects_bad_prefix_truncation_and_trailing_bytes() {
        let payload = Vaa::parse(&fixture("ethereum-usdc-to-hydration")).unwrap().payload;

        let mut bad = payload.clone();
        bad[0] = 0;
        assert!(matches!(TransceiverMessage::parse(&bad), Err(CodecError::InvalidPrefix(_))));

        assert_eq!(
            TransceiverMessage::parse(&payload[..payload.len() - 1]),
            Err(CodecError::Truncated)
        );

        let mut long = payload.clone();
        long.push(0);
        assert_eq!(TransceiverMessage::parse(&long), Err(CodecError::TrailingBytes));
    }

    #[test]
    fn digest_is_keccak_of_chain_and_message() {
        let (vaa, tm, _, _) = round_trip("ethereum-usdc-to-hydration");
        let d = manager_message_digest(vaa.emitter_chain, &tm.manager_payload);
        let mut preimage = vec![0x00, 0x02];
        preimage.extend_from_slice(&tm.manager_payload);
        assert_eq!(d, near_sdk::env::keccak256_array(&preimage));
        assert_ne!(d, manager_message_digest(73, &tm.manager_payload));
    }
}
