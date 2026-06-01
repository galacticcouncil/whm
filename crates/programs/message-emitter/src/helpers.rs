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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invariant_abi_encode_price_payload_roundtrips_fields() {
        let mut patterned_asset = [0u8; 32];
        for (i, byte) in patterned_asset.iter_mut().enumerate() {
            *byte = i as u8;
        }

        let cases = [
            (0u8, [0u8; 32], 0u128, 0u64),
            (1u8, [0xAA; 32], 1u128, 1u64),
            (255u8, patterned_asset, u128::MAX, u64::MAX),
        ];

        for (action, asset_id, price, timestamp) in cases {
            let encoded = abi_encode_price_payload(action, asset_id, price, timestamp);
            assert_eq!(encoded.len(), 128);

            assert!(encoded[0..31].iter().all(|b| *b == 0));
            assert_eq!(encoded[31], action);

            assert_eq!(&encoded[32..64], &asset_id);

            assert!(encoded[64..80].iter().all(|b| *b == 0));
            assert_eq!(
                u128::from_be_bytes(encoded[80..96].try_into().unwrap()),
                price
            );

            assert!(encoded[96..120].iter().all(|b| *b == 0));
            assert_eq!(
                u64::from_be_bytes(encoded[120..128].try_into().unwrap()),
                timestamp
            );
        }
    }
}
