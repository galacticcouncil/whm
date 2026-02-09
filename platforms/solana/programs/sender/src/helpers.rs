/// ABI-encode a string so that `abi.decode(payload, (string))` works on the EVM side.
///
/// Layout (Solidity ABI encoding of a single dynamic `string`):
///   bytes  0..32  : offset to string data = 0x20
///   bytes 32..64  : string byte-length (big-endian u256)
///   bytes 64..64+N: UTF-8 data, zero-padded to next 32-byte boundary
pub fn abi_encode_string(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let padded_len = (bytes.len() + 31) / 32 * 32;

    let mut encoded = Vec::with_capacity(64 + padded_len);

    // Offset to string data (always 32 for a single dynamic arg)
    let mut offset = [0u8; 32];
    offset[31] = 0x20;
    encoded.extend_from_slice(&offset);

    // String byte-length as big-endian u256
    let mut length = [0u8; 32];
    length[24..32].copy_from_slice(&(bytes.len() as u64).to_be_bytes());
    encoded.extend_from_slice(&length);

    // String data + zero padding
    encoded.extend_from_slice(bytes);
    encoded.resize(64 + padded_len, 0);

    encoded
}
