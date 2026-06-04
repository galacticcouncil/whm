// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

/// @title ScaleCodec - SCALE encoding primitives for Substrate interop
/// @notice Implements Substrate's SCALE (Simple Concatenated Aggregate Little-Endian) codec
library ScaleCodec {
    /// @notice Encode uint32 as SCALE Compact<u32>
    /// @dev Mode bits (2 LSBs): 00=single-byte, 01=two-byte, 10=four-byte
    function compactU32(uint32 value) internal pure returns (bytes memory) {
        if (value <= 0x3F) {
            // forge-lint: disable-next-line(unsafe-typecast)
            return abi.encodePacked(uint8(value << 2));
        } else if (value <= 0x3FFF) {
            // forge-lint: disable-next-line(unsafe-typecast)
            uint16 v = uint16(value << 2) | 0x01;
            // forge-lint: disable-next-line(unsafe-typecast)
            return abi.encodePacked(uint8(v), uint8(v >> 8));
        } else if (value <= 0x3FFFFFFF) {
            uint32 v = (value << 2) | 0x02;
            // forge-lint: disable-next-line(unsafe-typecast)
            return abi.encodePacked(uint8(v), uint8(v >> 8), uint8(v >> 16), uint8(v >> 24));
        }
        revert("ScaleCodec: compact u32 overflow");
    }

    /// @notice Encode uint128 as SCALE Compact<u128>
    /// @dev Extends compact encoding with big-integer mode (11) for values > 2^30
    function compactU128(uint128 value) internal pure returns (bytes memory) {
        if (value <= 0x3F) {
            // forge-lint: disable-next-line(unsafe-typecast)
            return abi.encodePacked(uint8(uint8(value) << 2));
        } else if (value <= 0x3FFF) {
            // forge-lint: disable-next-line(unsafe-typecast)
            uint16 v = uint16(value << 2) | 0x01;
            // forge-lint: disable-next-line(unsafe-typecast)
            return abi.encodePacked(uint8(v), uint8(v >> 8));
        } else if (value <= 0x3FFFFFFF) {
            // forge-lint: disable-next-line(unsafe-typecast)
            uint32 v = uint32(value << 2) | 0x02;
            // forge-lint: disable-next-line(unsafe-typecast)
            return abi.encodePacked(uint8(v), uint8(v >> 8), uint8(v >> 16), uint8(v >> 24));
        } else {
            uint128 tmp = value;
            uint8 n = 0;
            while (tmp > 0) {
                n++;
                tmp >>= 8;
            }
            bytes memory buf = new bytes(1 + n);
            buf[0] = bytes1(uint8(((n - 4) << 2) | 0x03));
            for (uint8 i = 0; i < n; i++) {
                // forge-lint: disable-next-line(unsafe-typecast)
                buf[1 + i] = bytes1(uint8(value));
                value >>= 8;
            }
            return buf;
        }
    }

    /// @notice Encode uint256 as 32-byte little-endian (SCALE U256)
    function u256Le(uint256 value) internal pure returns (bytes memory) {
        bytes memory r = new bytes(32);
        for (uint256 i; i < 32; i++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            r[i] = bytes1(uint8(value));
            value >>= 8;
        }
        return r;
    }

    /// @notice Encode uint64 as 8-byte little-endian (SCALE u64)
    function u64Le(uint64 value) internal pure returns (bytes memory) {
        bytes memory r = new bytes(8);
        for (uint256 i; i < 8; i++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            r[i] = bytes1(uint8(value));
            value >>= 8;
        }
        return r;
    }

    /// @notice Encode uint32 as 4-byte little-endian (SCALE u32)
    function u32Le(uint32 value) internal pure returns (bytes memory) {
        bytes memory r = new bytes(4);
        for (uint256 i; i < 4; i++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            r[i] = bytes1(uint8(value));
            value >>= 8;
        }
        return r;
    }

    /// @notice Encode bytes as SCALE Vec<u8> (compact length prefix + raw data)
    function encodeVecU8(bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(compactU32(uint32(data.length)), data);
    }

    /// @notice Encode SCALE Option::None
    function encodeNone() internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x00));
    }

    /// @notice Encode MultiAddress::Id variant (0x00 + 32-byte AccountId32)
    function multiAddressId(bytes32 accountId) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0x00), accountId);
    }
}
