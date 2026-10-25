//! Big-endian reading, and the VAA envelope. The core's `verify_vaa` checks signatures and the
//! guardian set but returns only the set index — the body is ours to read, after that call has
//! succeeded.

/// Big-endian cursor. Every read is checked; `finish` rejects trailing bytes.
pub(crate) struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    pub(crate) fn take(&mut self, n: usize) -> Result<&'a [u8], &'static str> {
        let end = self.pos.checked_add(n).ok_or("Truncated")?;
        let slice = self.buf.get(self.pos..end).ok_or("Truncated")?;
        self.pos = end;
        Ok(slice)
    }

    pub(crate) fn u8(&mut self) -> Result<u8, &'static str> {
        Ok(self.take(1)?[0])
    }

    pub(crate) fn u16(&mut self) -> Result<u16, &'static str> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }

    pub(crate) fn u32(&mut self) -> Result<u32, &'static str> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }

    pub(crate) fn u64(&mut self) -> Result<u64, &'static str> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }

    pub(crate) fn u128(&mut self) -> Result<u128, &'static str> {
        Ok(u128::from_be_bytes(self.take(16)?.try_into().unwrap()))
    }

    pub(crate) fn bytes20(&mut self) -> Result<[u8; 20], &'static str> {
        Ok(self.take(20)?.try_into().unwrap())
    }

    pub(crate) fn bytes32(&mut self) -> Result<[u8; 32], &'static str> {
        Ok(self.take(32)?.try_into().unwrap())
    }

    /// A `uint8` length, then that many bytes of UTF-8.
    pub(crate) fn string(&mut self) -> Result<String, &'static str> {
        let len = self.u8()? as usize;
        let bytes = self.take(len)?;
        String::from_utf8(bytes.to_vec()).map_err(|_| "InvalidUtf8")
    }

    pub(crate) fn rest(&mut self) -> &'a [u8] {
        let rest = &self.buf[self.pos..];
        self.pos = self.buf.len();
        rest
    }

    pub(crate) fn finish(&self) -> Result<(), &'static str> {
        if self.pos == self.buf.len() {
            Ok(())
        } else {
            Err("TrailingBytes")
        }
    }
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
    pub fn parse(encoded: &[u8]) -> Result<Self, &'static str> {
        let mut r = Reader::new(encoded);
        if r.u8()? != 1 {
            return Err("InvalidVaaVersion");
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
pub(crate) mod tests {
    use super::*;

    /// A VAA envelope with no signatures — enough for parsing; only the core verifies.
    pub(crate) fn vaa_bytes(timestamp: u32, chain: u16, emitter: [u8; 32], sequence: u64, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![1];
        out.extend_from_slice(&5u32.to_be_bytes());
        out.push(0);
        out.extend_from_slice(&timestamp.to_be_bytes());
        out.extend_from_slice(&0u32.to_be_bytes());
        out.extend_from_slice(&chain.to_be_bytes());
        out.extend_from_slice(&emitter);
        out.extend_from_slice(&sequence.to_be_bytes());
        out.push(202);
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn parses_the_envelope() {
        let vaa = Vaa::parse(&vaa_bytes(1_700_000_000, 73, [9; 32], 42, &[1, 2, 3])).unwrap();
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
        assert_eq!(Vaa::parse(&bytes), Err("Truncated"));
    }

    #[test]
    fn rejects_another_version() {
        let mut bytes = vaa_bytes(1, 73, [9; 32], 1, &[]);
        bytes[0] = 2;
        assert_eq!(Vaa::parse(&bytes), Err("InvalidVaaVersion"));
    }
}
