// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {NttPayload} from "../../src/ntt/NttPayload.sol";

/// @dev A payload the NEAR `ntt-manager` published through the real Wormhole NEAR core, on a
///      sandbox (`crates/near/sandbox`, `outbound_locks_and_publishes`): 1.5 wNEAR from
///      `alice.test.near` to 0x1111…1111 on Hydration. Parsed here the way EVM NTT parses it.
contract NearPayloadTest is Test {
    bytes constant PAYLOAD =
        hex"9945ff10116369a0f6a9810bb580b0e25237d2cdfada545054e4353b33d93506858083aa000000000000000000000000fcaf4aa069c565d25539028970703f01e47d3e0b009100000000000000000000000000000000000000000000000000000000000000000b53e6c36ede12dc3d8face9cd605cf05ac7305c0fe9833860edc7115a5c49fe004f994e5454080000000008f0d180d20ddda7505697670c7ad2f8555c920306ac0a2e12b8656af8a1a61d7d6e1899000000000000000000000000111111111111111111111111111111111111111100490000";

    function test_NearPayloadParsesAsNtt() public pure {
        (uint64 sequence, bytes memory message, uint8 decimals, uint64 amount) =
            NttPayload.settlementOf(PAYLOAD);

        assertEq(sequence, 0);
        assertEq(decimals, 8);
        assertEq(amount, 150_000_000);
        // The manager message is the digest preimage: id ‖ sender ‖ len ‖ transfer.
        assertEq(message.length, 32 + 32 + 2 + 79);
    }
}
