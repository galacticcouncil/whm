// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {ScaleCodec} from "../../src/utils/ScaleCodec.sol";

contract ScaleCodecTest is Test {
    // ─── Compact<u32> ──────────────────────────────────────────

    function testCompactU32SingleByte() public pure {
        assertEq(ScaleCodec.compactU32(0), hex"00");
        assertEq(ScaleCodec.compactU32(1), hex"04");
        assertEq(ScaleCodec.compactU32(42), hex"a8");
        assertEq(ScaleCodec.compactU32(63), hex"fc");
    }

    function testCompactU32TwoByte() public pure {
        assertEq(ScaleCodec.compactU32(64), hex"0101");
        assertEq(ScaleCodec.compactU32(16383), hex"fdff");
    }

    function testCompactU32FourByte() public pure {
        assertEq(ScaleCodec.compactU32(16384), hex"02000100");
        assertEq(ScaleCodec.compactU32(100000), hex"821a0600");
    }

    // ─── Compact<u128> ─────────────────────────────────────────

    function testCompactU128SmallValues() public pure {
        assertEq(ScaleCodec.compactU128(0), hex"00");
        assertEq(ScaleCodec.compactU128(42), hex"a8");
        assertEq(ScaleCodec.compactU128(64), hex"0101");
        assertEq(ScaleCodec.compactU128(100000), hex"821a0600");
    }

    function testCompactU128BigInteger() public pure {
        assertEq(ScaleCodec.compactU128(1_000_000_000_000), hex"070010a5d4e8");
    }

    // ─── u256Le ────────────────────────────────────────────────

    function testU256LeZero() public pure {
        bytes memory encoded = ScaleCodec.u256Le(0);
        assertEq(encoded.length, 32);
        assertEq(encoded, new bytes(32));
    }

    function testU256LeOne() public pure {
        bytes memory encoded = ScaleCodec.u256Le(1);
        assertEq(encoded[0], bytes1(0x01));
        for (uint256 i = 1; i < 32; i++) {
            assertEq(encoded[i], bytes1(0x00));
        }
    }

    // ─── u64Le ─────────────────────────────────────────────────

    function testU64Le() public pure {
        assertEq(ScaleCodec.u64Le(200_000), hex"400d030000000000");
    }

    // ─── Vec<u8> ───────────────────────────────────────────────

    function testEncodeVecU8Empty() public pure {
        assertEq(ScaleCodec.encodeVecU8(hex""), hex"00");
    }

    function testEncodeVecU8Short() public pure {
        assertEq(ScaleCodec.encodeVecU8(hex"deadbeef"), hex"10deadbeef");
    }
}
