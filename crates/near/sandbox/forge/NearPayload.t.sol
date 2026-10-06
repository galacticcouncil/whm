// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Test.sol";
import "../src/libraries/TransceiverStructs.sol";
import "../src/libraries/TrimmedAmount.sol";

/// A payload published by the NEAR `ntt-manager` through the real Wormhole NEAR core in a sandbox,
/// parsed and re-encoded by the real TransceiverStructs Hydration's manager uses.
contract NearPayloadTest is Test {
    using TrimmedAmountLib for TrimmedAmount;

    bytes constant PAYLOAD =
        hex"9945ff10116369a0f6a9810bb580b0e25237d2cdfada545054e4353b33d93506858083aa000000000000000000000000fcaf4aa069c565d25539028970703f01e47d3e0b009100000000000000000000000000000000000000000000000000000000000000000b53e6c36ede12dc3d8face9cd605cf05ac7305c0fe9833860edc7115a5c49fe004f994e5454080000000008f0d180d20ddda7505697670c7ad2f8555c920306ac0a2e12b8656af8a1a61d7d6e1899000000000000000000000000111111111111111111111111111111111111111100490000";

    bytes4 constant WH_PREFIX = 0x9945FF10;

    function test_parsesNearPayload() public {
        TransceiverStructs.TransceiverMessage memory tm =
            TransceiverStructs.parseTransceiverMessage(WH_PREFIX, PAYLOAD);
        assertEq(tm.sourceNttManagerAddress, sha256(bytes("ntt.test.near")));
        assertEq(
            tm.recipientNttManagerAddress,
            bytes32(uint256(uint160(0xFCaF4aA069C565d25539028970703F01e47D3E0B)))
        );
        assertEq(tm.transceiverPayload.length, 0);

        TransceiverStructs.NttManagerMessage memory mm =
            TransceiverStructs.parseNttManagerMessage(tm.nttManagerPayload);
        assertEq(mm.id, bytes32(0));
        assertEq(mm.sender, sha256(bytes("alice.test.near")));

        TransceiverStructs.NativeTokenTransfer memory ntt =
            TransceiverStructs.parseNativeTokenTransfer(mm.payload);
        assertEq(ntt.amount.getAmount(), 150_000_000);
        assertEq(ntt.amount.getDecimals(), 8);
        assertEq(ntt.sourceToken, sha256(bytes("wrap.test.near")));
        assertEq(ntt.to, bytes32(uint256(uint160(0x1111111111111111111111111111111111111111))));
        assertEq(ntt.toChain, 73);
        assertEq(ntt.additionalPayload.length, 0);

        // Solidity re-encodes to the same bytes, layer by layer.
        assertEq(TransceiverStructs.encodeNativeTokenTransfer(ntt), mm.payload);
        assertEq(TransceiverStructs.encodeNttManagerMessage(mm), tm.nttManagerPayload);
        assertEq(TransceiverStructs.encodeTransceiverMessage(WH_PREFIX, tm), PAYLOAD);
    }
}
