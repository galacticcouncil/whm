//! Big-endian wire reading. Every read is checked; `finish` rejects trailing bytes, as
//! `checkLength` does on EVM.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodecError {
    Truncated,
    TrailingBytes,
    InvalidPrefix([u8; 4]),
    PayloadTooLong,
    InvalidUtf8,
}

impl CodecError {
    /// The variant's name — what a contract panics with.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Truncated => "Truncated",
            Self::TrailingBytes => "TrailingBytes",
            Self::InvalidPrefix(_) => "InvalidPrefix",
            Self::PayloadTooLong => "PayloadTooLong",
            Self::InvalidUtf8 => "InvalidUtf8",
        }
    }
}

/// So `?` works in parsers that report errors by name.
impl From<CodecError> for &'static str {
    fn from(e: CodecError) -> Self {
        e.as_str()
    }
}

pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    pub fn take(&mut self, n: usize) -> Result<&'a [u8], CodecError> {
        let end = self.pos.checked_add(n).ok_or(CodecError::Truncated)?;
        let slice = self.buf.get(self.pos..end).ok_or(CodecError::Truncated)?;
        self.pos = end;
        Ok(slice)
    }

    pub fn u8(&mut self) -> Result<u8, CodecError> {
        Ok(self.take(1)?[0])
    }

    pub fn u16(&mut self) -> Result<u16, CodecError> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }

    pub fn u32(&mut self) -> Result<u32, CodecError> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }

    pub fn u64(&mut self) -> Result<u64, CodecError> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }

    pub fn u128(&mut self) -> Result<u128, CodecError> {
        Ok(u128::from_be_bytes(self.take(16)?.try_into().unwrap()))
    }

    pub fn bytes4(&mut self) -> Result<[u8; 4], CodecError> {
        Ok(self.take(4)?.try_into().unwrap())
    }

    pub fn bytes20(&mut self) -> Result<[u8; 20], CodecError> {
        Ok(self.take(20)?.try_into().unwrap())
    }

    pub fn bytes32(&mut self) -> Result<[u8; 32], CodecError> {
        Ok(self.take(32)?.try_into().unwrap())
    }

    /// A `uint16` length, then that many bytes.
    pub fn prefixed(&mut self) -> Result<Vec<u8>, CodecError> {
        let len = self.u16()? as usize;
        Ok(self.take(len)?.to_vec())
    }

    /// A `uint8` length, then that many bytes of UTF-8.
    pub fn string(&mut self) -> Result<String, CodecError> {
        let len = self.u8()? as usize;
        String::from_utf8(self.take(len)?.to_vec()).map_err(|_| CodecError::InvalidUtf8)
    }

    pub fn rest(&mut self) -> &'a [u8] {
        let rest = &self.buf[self.pos..];
        self.pos = self.buf.len();
        rest
    }

    pub fn is_empty(&self) -> bool {
        self.pos == self.buf.len()
    }

    pub fn finish(&self) -> Result<(), CodecError> {
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

    #[test]
    fn reads_big_endian_and_checks_bounds() {
        let bytes = [0x01, 0x02, 0x03, 0x00, 0x02, 0xaa, 0xbb, 0x02, b'h', b'i'];
        let mut r = Reader::new(&bytes);
        assert_eq!(r.u8(), Ok(1));
        assert_eq!(r.u16(), Ok(0x0203));
        assert_eq!(r.prefixed(), Ok(vec![0xaa, 0xbb]));
        assert_eq!(r.string(), Ok("hi".into()));
        assert!(r.is_empty());
        assert_eq!(r.finish(), Ok(()));
        assert_eq!(r.u8(), Err(CodecError::Truncated));
    }

    #[test]
    fn trailing_bytes_and_bad_utf8() {
        let r = Reader::new(&[0]);
        assert_eq!(r.finish(), Err(CodecError::TrailingBytes));
        assert_eq!(Reader::new(&[1, 0xff]).string(), Err(CodecError::InvalidUtf8));
    }

    #[test]
    fn errors_by_name() {
        let e: &'static str = CodecError::InvalidPrefix([1, 2, 3, 4]).into();
        assert_eq!(e, "InvalidPrefix");
    }
}
