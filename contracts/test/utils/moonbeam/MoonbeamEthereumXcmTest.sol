// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {MoonbeamEthereumXcm} from "../../../src/utils/moonbeam/MoonbeamEthereumXcm.sol";

/// @notice Byte-level checks for the ethereum_xcm encoder.
contract MoonbeamEthereumXcmTest is Test {
    address constant BASEJUMP_PROXY = 0xB1731c586ca89a23809861c6103F0b96B3F57D92;

    // ethereum_xcm.transact(V1): 6d 00 00 [gas U256] 01(Auto) 00(Call) [target] [value 0] [input] 00
    function test_ethereumXcmTransact_framing() public pure {
        bytes memory input = hex"deadbeef";
        bytes memory call = MoonbeamEthereumXcm.transact(5_000_000, BASEJUMP_PROXY, input);
        // prefix: pallet 0x6d, transact 0x00, V1 0x00, gas_limit 5_000_000 (U256 LE)
        assertEq(
            _slice(call, 0, 35),
            abi.encodePacked(hex"6d0000", _u256Le(5_000_000))
        );
        // after gas: fee_payment Auto (0x01), action Call (0x00), target (20 bytes)
        assertEq(_slice(call, 35, 22), abi.encodePacked(hex"0100", bytes20(BASEJUMP_PROXY)));
    }

    // ─── helpers ─────────────────────────────────────────────────

    function _slice(bytes memory data, uint256 start, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; i++) {
            out[i] = data[start + i];
        }
    }

    function _u256Le(uint256 value) internal pure returns (bytes memory r) {
        r = new bytes(32);
        for (uint256 i; i < 32; i++) {
            r[i] = bytes1(uint8(value));
            value >>= 8;
        }
    }
}
