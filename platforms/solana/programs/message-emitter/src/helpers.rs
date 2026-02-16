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

/// ABI-encode a price payload so the EVM receiver can decode it as:
///   `abi.decode(payload, (uint8, bytes32, uint256, uint64))`
///
/// Layout (all static types, each left-padded to 32 bytes):
///   bytes   0..32  : action   (uint8)
///   bytes  32..64  : assetId  (bytes32)
///   bytes  64..96  : price    (uint256, 18-decimal normalised)
///   bytes  96..128 : timestamp (uint64)
pub fn abi_encode_price_payload(
    action: u8,
    asset_id: [u8; 32],
    price: u128,
    timestamp: u64,
) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(128);

    // action — uint8 left-padded to 32 bytes
    let mut slot = [0u8; 32];
    slot[31] = action;
    encoded.extend_from_slice(&slot);

    // assetId — bytes32 (already 32 bytes, no padding needed)
    encoded.extend_from_slice(&asset_id);

    // price — uint256 as big-endian, left-padded to 32 bytes
    let mut slot = [0u8; 32];
    slot[16..32].copy_from_slice(&price.to_be_bytes());
    encoded.extend_from_slice(&slot);

    // timestamp — uint64 left-padded to 32 bytes
    let mut slot = [0u8; 32];
    slot[24..32].copy_from_slice(&timestamp.to_be_bytes());
    encoded.extend_from_slice(&slot);

    encoded
}
