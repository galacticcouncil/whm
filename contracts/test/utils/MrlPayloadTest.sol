// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {MrlPayload} from "../../src/utils/MrlPayload.sol";

contract MrlPayloadTest is Test {
    uint32 constant HYDRATION_PARA_ID = 2034;

    // Alice's public key
    bytes32 constant ALICE = 0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d;

    // ─── AccountId32 (Substrate) ────────────────────────────────

    function testEncodeAccountId32() public pure {
        bytes memory payload = MrlPayload.encode(HYDRATION_PARA_ID, ALICE);
        assertEq(
            payload,
            hex"0005010200c91f0100d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d"
        );
    }

    // ─── AccountKey20 (Ethereum) ────────────────────────────────

    function testEncodeAccountKey20() public pure {
        address ethAddress = 0x1234567890123456789012345678901234567890;
        bytes memory payload = MrlPayload.encodeEth(HYDRATION_PARA_ID, ethAddress);

        // Should contain the eth address bytes
        assertEq(
            payload,
            abi.encodePacked(
                hex"0005010200c91f0300",
                bytes20(ethAddress)
            )
        );
    }

    function testEncodeAccountKey20ContainsAddress() public pure {
        address ethAddress = 0x1234567890123456789012345678901234567890;
        bytes memory payload = MrlPayload.encodeEth(HYDRATION_PARA_ID, ethAddress);
        string memory hex_ = vm.toString(payload);

        // Address bytes should appear in the encoded payload
        assertNotEq(
            _indexOf(hex_, "1234567890123456789012345678901234567890"),
            -1
        );
    }

    // ─── Round-trip structure ───────────────────────────────────

    function testEncodeDifferentParachains() public pure {
        bytes memory hydration = MrlPayload.encode(2034, ALICE);
        bytes memory other = MrlPayload.encode(1000, ALICE);

        // Different parachain IDs produce different payloads
        assertNotEq(keccak256(hydration), keccak256(other));

        // Both start with same prefix (V1 + V5 + parents=1 + X2 + Parachain)
        assertEq(uint8(hydration[0]), 0x00); // V1
        assertEq(uint8(hydration[1]), 0x05); // V5
        assertEq(uint8(other[0]), 0x00);
        assertEq(uint8(other[1]), 0x05);
    }

    // ─── Helpers ────────────────────────────────────────────────

    function _indexOf(string memory haystack, string memory needle) internal pure returns (int256) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return -1;
        for (uint256 i = 0; i <= h.length - n.length; i++) {
            bool found = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    found = false;
                    break;
                }
            }
            // forge-lint: disable-next-line(unsafe-typecast)
            if (found) return int256(i);
        }
        return -1;
    }
}
