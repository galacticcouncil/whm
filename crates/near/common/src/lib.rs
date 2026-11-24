//! Code the WHM NEAR contracts share: the big-endian wire reader, Wormhole VAAs and the core's
//! interface, NEAR's MPC signer, RFC 3339 time, and hex arguments.

pub mod codec;
pub mod mpc;
pub mod time;
pub mod vaa;

use near_sdk::env;

/// A 32-byte hex argument, with or without `0x`.
pub fn parse_bytes32(value: &str) -> [u8; 32] {
    let bytes = hex::decode(value.trim_start_matches("0x")).unwrap_or_else(|_| env::panic_str("InvalidHex"));
    bytes.try_into().unwrap_or_else(|_| env::panic_str("InvalidBytes32"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_with_or_without_prefix() {
        assert_eq!(parse_bytes32(&"ab".repeat(32)), [0xab; 32]);
        assert_eq!(parse_bytes32(&format!("0x{}", "ab".repeat(32))), [0xab; 32]);
    }

    #[test]
    #[should_panic(expected = "InvalidBytes32")]
    fn wrong_length() {
        parse_bytes32("abab");
    }
}
