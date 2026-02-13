// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {ScaleCodec} from "../src/ScaleCodec.sol";
import {XcmTransactor} from "../src/XcmTransactor.sol";

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

contract XcmTransactorTest is Test {
    XcmTransactor public transactor;

    uint32 constant HYDRATION_PARA_ID = 2034;
    uint8 constant EVM_PALLET_INDEX = 36;
    uint8 constant EVM_CALL_INDEX = 0;

    function setUp() public {
        transactor = new XcmTransactor(HYDRATION_PARA_ID, EVM_PALLET_INDEX, EVM_CALL_INDEX);
        transactor.setAuthorized(address(this), true);
        transactor.setXcmSource(address(0x1111111111111111111111111111111111111111));
    }

    function testOnlyAuthorizedCanTransact() public {
        vm.prank(address(0xdead));
        vm.expectRevert(XcmTransactor.NotAuthorized.selector);
        transactor.transact(address(0xBEEF), hex"");
    }

    function testOnlyOwnerCanSetAuthorized() public {
        vm.prank(address(0xdead));
        vm.expectRevert(XcmTransactor.NotOwner.selector);
        transactor.setAuthorized(address(0xCAFE), true);
    }

    function testSetAuthorized() public {
        transactor.setAuthorized(address(0xCAFE), true);
        assertTrue(transactor.authorized(address(0xCAFE)));

        transactor.setAuthorized(address(0xCAFE), false);
        assertFalse(transactor.authorized(address(0xCAFE)));
    }

    function testOnlyAuthorizedCanSetDefaults() public {
        vm.prank(address(0xdead));
        vm.expectRevert(XcmTransactor.NotAuthorized.selector);
        transactor.setXcmDefaults(0, 0, 0, 0, 0);
    }

    function testSetXcmDefaults() public {
        transactor.setXcmDefaults(500_000, 2e9, 400_000_000, 8_000_000_000, 2e12);
        assertEq(transactor.xcmGasLimit(), 500_000);
        assertEq(transactor.xcmMaxFeePerGas(), 2e9);
    }

    function testImmutableConfig() public view {
        assertEq(transactor.HYDRATION_PARA_ID(), HYDRATION_PARA_ID);
        assertEq(transactor.EVM_PALLET_INDEX(), EVM_PALLET_INDEX);
        assertEq(transactor.EVM_CALL_INDEX(), EVM_CALL_INDEX);
    }
}
