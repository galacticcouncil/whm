// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PsmPayload} from "../../../src/psm/lib/PsmPayload.sol";

/// @title PsmPayload wire-format tests
/// @notice The wire is the one thing both contracts must agree on byte for byte, and a mistake in
///         it is unrecoverable: VAAs are permanent, so a body that decodes differently on the two
///         sides strands every message already attested.
contract PsmPayloadTest is Test {
    using PsmPayload for bytes;

    // Constructed independently of the library, from the layout diagram in the spec's section 5:
    //   version 1 | kind 2 (redeem) | recipient 0x1111…0000 left-padded | amount 1_000_000 (1 USDC)
    bytes internal constant GOLDEN =
        hex"0102000000000000000000000000111122223333444455556666777788889999000000000000000000000000000000000000000000000000000000000000000f4240";

    address internal constant GOLDEN_ADDR = 0x1111222233334444555566667777888899990000;
    uint256 internal constant GOLDEN_AMOUNT = 1_000_000;

    // ─── The layout itself ──────────────────────────────────────

    /// @dev The load-bearing test. A round-trip passes even when encode and decode are wrong in
    ///      the same way; only a fixture built outside the library catches that.
    function test_encode_matchesGoldenVector() public pure {
        bytes memory out = PsmPayload.encode(PsmPayload.KIND_REDEEM, PsmPayload.fromAddress(GOLDEN_ADDR), GOLDEN_AMOUNT);
        assertEq(out.length, PsmPayload.LENGTH, "length must be exactly 66");
        assertEq(out, GOLDEN, "byte layout drifted from the spec");
    }

    function test_decode_readsGoldenVector() public pure {
        (uint8 kind, bytes32 recipient, uint256 amount) = PsmPayload.decode(GOLDEN);
        assertEq(kind, PsmPayload.KIND_REDEEM);
        assertEq(PsmPayload.toAddress(recipient), GOLDEN_ADDR);
        assertEq(amount, GOLDEN_AMOUNT);
    }

    // ─── Round trip ─────────────────────────────────────────────

    function testFuzz_roundTrip(uint8 rawKind, address recipient, uint256 amount) public pure {
        uint8 kind = uint8(bound(rawKind, PsmPayload.KIND_MINT, PsmPayload.KIND_REFUND));
        vm.assume(recipient != address(0));

        bytes memory body = PsmPayload.encode(kind, PsmPayload.fromAddress(recipient), amount);
        (uint8 k, bytes32 r, uint256 a) = PsmPayload.decode(body);

        assertEq(k, kind);
        assertEq(PsmPayload.toAddress(r), recipient);
        assertEq(a, amount);
    }

    /// @dev Amount is uint256 on the wire, so no corridor size can overflow the field. Pinned so a
    ///      later "optimisation" to a narrower type has to break a test.
    function testFuzz_amountSurvivesFullWidth(uint256 amount) public pure {
        bytes memory body = PsmPayload.encode(PsmPayload.KIND_MINT, PsmPayload.fromAddress(address(1)), amount);
        (,, uint256 a) = PsmPayload.decode(body);
        assertEq(a, amount);
    }

    // ─── Refusals: version ──────────────────────────────────────

    /// @dev An unrecognised version is refused, never parsed and never read as empty. A silent
    ///      shape change would look like a clean boot and disarm every check downstream.
    function testFuzz_decode_rejectsUnknownVersion(uint8 version) public {
        vm.assume(version != PsmPayload.VERSION);
        bytes memory body = abi.encodePacked(version, PsmPayload.KIND_MINT, bytes32(uint256(1)), uint256(1));
        vm.expectRevert(abi.encodeWithSelector(PsmPayload.UnsupportedVersion.selector, version));
        this.decodeExternal(body);
    }

    // ─── Refusals: kind ─────────────────────────────────────────

    function testFuzz_decode_rejectsUnknownKind(uint8 kind) public {
        vm.assume(kind < PsmPayload.KIND_MINT || kind > PsmPayload.KIND_REFUND);
        bytes memory body = abi.encodePacked(PsmPayload.VERSION, kind, bytes32(uint256(1)), uint256(1));
        vm.expectRevert(abi.encodeWithSelector(PsmPayload.UnknownKind.selector, kind));
        this.decodeExternal(body);
    }

    function testFuzz_encode_rejectsUnknownKind(uint8 kind) public {
        vm.assume(kind < PsmPayload.KIND_MINT || kind > PsmPayload.KIND_REFUND);
        vm.expectRevert(abi.encodeWithSelector(PsmPayload.UnknownKind.selector, kind));
        this.encodeExternal(kind, bytes32(uint256(1)), 1);
    }

    // ─── Refusals: length ───────────────────────────────────────

    /// @dev Neither padded nor truncated. A short body read as though it were full would take
    ///      whatever memory follows it as the amount.
    function testFuzz_decode_rejectsWrongLength(uint8 len) public {
        vm.assume(len != PsmPayload.LENGTH);
        bytes memory body = new bytes(len);
        if (len > 0) body[0] = bytes1(PsmPayload.VERSION);
        vm.expectRevert(abi.encodeWithSelector(PsmPayload.InvalidLength.selector, uint256(len)));
        this.decodeExternal(body);
    }

    // ─── Refusals: recipient shape ──────────────────────────────

    /// @dev Rejected, never truncated. Truncation lets a sender pick two distinct 32-byte values
    ///      that credit one account, which is a way to smuggle a second identity past a check.
    function testFuzz_toAddress_rejectsDirtyHighBytes(uint96 dirt, address a) public {
        vm.assume(dirt != 0);
        bytes32 raw = bytes32((uint256(dirt) << 160) | uint256(uint160(a)));
        vm.expectRevert(abi.encodeWithSelector(PsmPayload.NotAnAddress.selector, raw));
        this.toAddressExternal(raw);
    }

    function test_toAddress_rejectsZero() public {
        vm.expectRevert(PsmPayload.ZeroRecipient.selector);
        this.toAddressExternal(bytes32(0));
    }

    function testFuzz_toAddress_acceptsCleanAddress(address a) public pure {
        vm.assume(a != address(0));
        assertEq(PsmPayload.toAddress(PsmPayload.fromAddress(a)), a);
    }

    // ─── external wrappers so expectRevert sees a real call frame ───

    function decodeExternal(bytes memory b) external pure returns (uint8, bytes32, uint256) {
        return PsmPayload.decode(b);
    }

    function encodeExternal(uint8 k, bytes32 r, uint256 a) external pure returns (bytes memory) {
        return PsmPayload.encode(k, r, a);
    }

    function toAddressExternal(bytes32 raw) external pure returns (address) {
        return PsmPayload.toAddress(raw);
    }
}
