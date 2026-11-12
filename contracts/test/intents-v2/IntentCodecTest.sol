// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {IntentCodec} from "../../src/intents-v2/IntentCodec.sol";
import {IIntentDispatcher} from "../../src/intents-v2/interfaces/IIntentDispatcher.sol";

/// @dev The codec is a library, so its reverts are inlined into the caller rather than raised in a
///      subcall — `expectRevert` needs a real call frame to catch. This is that frame.
contract CodecHarness {
    function encode(IIntentDispatcher.Quote calldata terms) external pure returns (bytes memory) {
        return IntentCodec.encodeQuote(terms);
    }

    function decode(bytes memory terms) external pure returns (IIntentDispatcher.Quote memory) {
        return IntentCodec.decodeQuote(terms);
    }

    function encodeOrder(bytes32 path, IIntentDispatcher.Order calldata o) external pure returns (bytes memory) {
        return IntentCodec.encodeOrder(path, o);
    }

    function authPath(IIntentDispatcher.Quote calldata terms) external pure returns (bytes32) {
        return IntentCodec.authPath(terms);
    }

    function encodeForward(address depositAddress, uint256 maxRelayFee) external pure returns (bytes memory) {
        return IntentCodec.encodeForward(depositAddress, maxRelayFee);
    }

    function decodeForward(bytes memory payload) external pure returns (address, uint256) {
        return IntentCodec.decodeForward(payload);
    }
}

/// @title IntentCodecTest
/// @notice Pins the wire formats intents v2 crosses chains with — the terms, hashed into the account
///         `A`, and the order message, both read by NEAR's router, to the router's own golden
///         vectors; and the forward payload the Ethereum forwarder reads from the NTT transfer.
contract IntentCodecTest is Test {
    CodecHarness public codec;

    string constant ZEC = "nep141:zec.omft.near";
    string constant T_ADDR = "t1KPVSRgnFHPBWMJLC7taJioN6m5Q6jVBma";

    /// @dev `terms.rs` `sample()` in the router — encoded by its Rust codec and by
    ///      `scripts/intent-router/shared.ts` `encodeTerms`, both to these bytes.
    bytes constant GOLDEN_TERMS =
        hex"0133333333333333333333333333333333333333331111111111111111111111111111111111111111111111111111111111111111006400000000000000000000000008f0d180000000000000000000000000000f4240000000006b49d200002222222222222222222222222222222222222222146e65703134313a7a65632e6f6d66742e6e6561722374314b50565352676e46485042574d4a4c433774614a696f4e366d3551366a56426d61";
    bytes32 constant GOLDEN_PATH = 0x09650cc18201991ec766eaa964833b0f8074f86c700b1f5710c965950bcd1846;

    /// @dev `order.rs` `golden_vector()` in the router: path 0x07…07, seq 9, 0.001 ETH, 1.8 ZEC/ETH.
    bytes constant GOLDEN_ORDER =
        hex"0107070707070707070707070707070707070707070707070707070707070707070000000000000009000000000000000000038d7ea4c680000000000000000000000000000aba9500";

    function setUp() public {
        codec = new CodecHarness();
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _terms() internal pure returns (IIntentDispatcher.Quote memory) {
        return IIntentDispatcher.Quote({
            owner: address(0x3333333333333333333333333333333333333333),
            quoteId: bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111)),
            maxSlippageBps: 100,
            minOutPerIn: 150_000_000,
            minDelivery: 1_000_000,
            deadline: 1_800_000_000,
            recipientKind: IntentCodec.KIND_WITHDRAW,
            refundTo: address(0x2222222222222222222222222222222222222222),
            destinationAsset: ZEC,
            recipient: T_ADDR
        });
    }

    function _order() internal pure returns (IIntentDispatcher.Order memory) {
        return IIntentDispatcher.Order({seq: 9, amount: 1e15, outPerIn: 180_000_000});
    }

    // ─── Wire-format readers (independent of the encoder) ───────────

    function _uint(bytes memory b, uint256 o, uint256 size) internal pure returns (uint256 v) {
        for (uint256 i = 0; i < size; i++) {
            v = (v << 8) | uint8(b[o + i]);
        }
    }

    function _str(bytes memory b, uint256 o, uint256 len) internal pure returns (string memory) {
        bytes memory s = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            s[i] = b[o + i];
        }
        return string(s);
    }

    // ─── Terms ──────────────────────────────────────────────────────

    /// @notice The bytes the router hashes into `A`, equal to its own Rust and TypeScript encoders'.
    ///         A mismatch here is a different account on NEAR.
    function testTermsMatchTheRoutersGoldenVector() public view {
        assertEq(codec.encode(_terms()), GOLDEN_TERMS, "terms");
        assertEq(codec.authPath(_terms()), GOLDEN_PATH, "path");
        assertEq(keccak256(GOLDEN_TERMS), GOLDEN_PATH, "path is keccak of the terms");
    }

    /// @notice The router decodes by offset, so the layout is read back field by field rather than
    ///         by re-encoding.
    function testTermsWireFormat() public view {
        bytes memory p = codec.encode(_terms());
        assertEq(_uint(p, 0, 1), 1, "version");
        assertEq(address(uint160(_uint(p, 1, 20))), address(0x3333333333333333333333333333333333333333), "owner");
        assertEq(bytes32(_uint(p, 21, 32)), _terms().quoteId, "quoteId");
        assertEq(_uint(p, 53, 2), 100, "maxSlippageBps");
        assertEq(_uint(p, 55, 16), 150_000_000, "minOutPerIn");
        assertEq(_uint(p, 71, 16), 1_000_000, "minDelivery");
        assertEq(_uint(p, 87, 8), 1_800_000_000, "deadline");
        assertEq(_uint(p, 95, 1), 0, "recipientKind");
        assertEq(address(uint160(_uint(p, 96, 20))), address(0x2222222222222222222222222222222222222222), "refundTo");

        uint256 assetLen = _uint(p, 116, 1);
        assertEq(_str(p, 117, assetLen), ZEC, "destinationAsset");
        uint256 recipientLen = _uint(p, 117 + assetLen, 1);
        assertEq(_str(p, 118 + assetLen, recipientLen), T_ADDR, "recipient");
        // Declared lengths account for the whole buffer — a payload the router could truncate
        // rather than reject would have a second reading.
        assertEq(p.length, 118 + assetLen + recipientLen, "trailing bytes");
    }

    function testTermsRoundTripThroughTheDecoder() public view {
        IIntentDispatcher.Quote memory t = codec.decode(GOLDEN_TERMS);
        assertEq(abi.encode(t), abi.encode(_terms()), "round trip");
    }

    /// @notice Each check the router's parser makes, made by the encoder first — terms it accepts
    ///         but the router rejects would leave their account unable even to refund.
    function testEncoderRejectsWhatTheRouterRejects() public {
        IIntentDispatcher.Quote memory t = _terms();

        t.owner = address(0);
        vm.expectRevert(IntentCodec.InvalidOwner.selector);
        codec.encode(t);

        t = _terms();
        t.quoteId = bytes32(0);
        vm.expectRevert(IntentCodec.InvalidQuoteId.selector);
        codec.encode(t);

        t = _terms();
        t.maxSlippageBps = 10_000;
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.InvalidSlippage.selector, 10_000));
        codec.encode(t);

        t = _terms();
        t.deadline = 0;
        vm.expectRevert(IntentCodec.InvalidDeadline.selector);
        codec.encode(t);

        t = _terms();
        t.recipientKind = 2;
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.InvalidRecipientKind.selector, 2));
        codec.encode(t);

        t = _terms();
        t.refundTo = address(0);
        vm.expectRevert(IntentCodec.InvalidRefundTo.selector);
        codec.encode(t);

        t = _terms();
        t.destinationAsset = "";
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.InvalidDestinationAsset.selector, 0));
        codec.encode(t);

        t = _terms();
        t.recipient = "t1 x";
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.InvalidRecipient.selector, 4));
        codec.encode(t);

        t = _terms();
        t.recipient = string(new bytes(256));
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.InvalidRecipient.selector, 256));
        codec.encode(t);
    }

    /// @notice An intents recipient is only structurally checked here, as in the router's parser —
    ///         whether it is an account id is checked at swap and delivery, so such terms still refund.
    function testIntentsRecipientIsStructuralOnly() public view {
        IIntentDispatcher.Quote memory t = _terms();
        t.recipientKind = IntentCodec.KIND_INTENTS_ACCOUNT;
        t.recipient = "Not_An.Account";
        codec.encode(t);
    }

    function testDecoderRejectsMalformedTerms() public {
        bytes memory truncated = new bytes(GOLDEN_TERMS.length - 1);
        for (uint256 i = 0; i < truncated.length; i++) {
            truncated[i] = GOLDEN_TERMS[i];
        }
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.MalformedTerms.selector, truncated.length));
        codec.decode(truncated);

        bytes memory padded = bytes.concat(GOLDEN_TERMS, hex"00");
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.MalformedTerms.selector, padded.length));
        codec.decode(padded);

        bytes memory otherVersion = bytes.concat(hex"02", _tail(GOLDEN_TERMS));
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.InvalidVersion.selector, 2));
        codec.decode(otherVersion);
    }

    function _tail(bytes memory b) internal pure returns (bytes memory out) {
        out = new bytes(b.length - 1);
        for (uint256 i = 1; i < b.length; i++) {
            out[i - 1] = b[i];
        }
    }

    /// @notice Every field moves the path — a change to any term is a different account.
    function testEveryTermMovesThePath() public view {
        bytes32 base = codec.authPath(_terms());
        IIntentDispatcher.Quote memory t;

        t = _terms(); t.owner = address(0x4444);
        assertTrue(codec.authPath(t) != base, "owner");
        t = _terms(); t.maxSlippageBps = 99;
        assertTrue(codec.authPath(t) != base, "slippage");
        t = _terms(); t.minOutPerIn = 1;
        assertTrue(codec.authPath(t) != base, "hard floor");
        t = _terms(); t.minDelivery = 1;
        assertTrue(codec.authPath(t) != base, "minDelivery");
        t = _terms(); t.deadline = 1;
        assertTrue(codec.authPath(t) != base, "deadline");
        t = _terms(); t.refundTo = address(0x3333);
        assertTrue(codec.authPath(t) != base, "refundTo");
        t = _terms(); t.recipient = "t1KPVSRgnFHPBWMJLC7taJioN6m5Q6jVBmb";
        assertTrue(codec.authPath(t) != base, "recipient");
    }

    /// @notice The length bytes keep field boundaries unambiguous: moving a byte between the two
    ///         strings changes the path.
    function testPathIsUnambiguousAcrossFieldBoundaries() public view {
        IIntentDispatcher.Quote memory a = _terms();
        a.destinationAsset = "nep141:a";
        a.recipient = "bc";
        IIntentDispatcher.Quote memory b = _terms();
        b.destinationAsset = "nep141:ab";
        b.recipient = "c";
        assertTrue(codec.authPath(a) != codec.authPath(b));
    }

    // ─── Orders ─────────────────────────────────────────────────────

    function testOrderMatchesTheRoutersGoldenVector() public view {
        bytes32 path = bytes32(uint256(0x0707070707070707070707070707070707070707070707070707070707070707));
        assertEq(codec.encodeOrder(path, _order()), GOLDEN_ORDER);
    }

    // ─── Forward ────────────────────────────────────────────────────

    function testForwardPayload() public view {
        address deposit = address(0x04624e5890ed9c703D94652E19E4e327E2F4002a);
        bytes memory p = codec.encodeForward(deposit, 5e10);
        assertEq(p, abi.encodePacked(uint8(1), deposit, uint128(5e10)), "version | depositAddress | maxRelayFee");
        assertEq(p.length, 37, "37 bytes, well under the manager's payload cap");
        (address d, uint256 fee) = codec.decodeForward(p);
        assertEq(d, deposit);
        assertEq(fee, 5e10);
    }

    function testForwardRejectsAnythingElse() public {
        bytes memory p = codec.encodeForward(address(0xBEEF), 1);

        vm.expectRevert(abi.encodeWithSelector(IntentCodec.MalformedForward.selector, 36));
        codec.decodeForward(_head(p, 36));

        vm.expectRevert(abi.encodeWithSelector(IntentCodec.MalformedForward.selector, 38));
        codec.decodeForward(bytes.concat(p, hex"00"));

        p[0] = 0x02;
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.MalformedForward.selector, 37));
        codec.decodeForward(p);

        vm.expectRevert(abi.encodeWithSelector(IntentCodec.InvalidRelayFee.selector, uint256(type(uint128).max) + 1));
        codec.encodeForward(address(0xBEEF), uint256(type(uint128).max) + 1);
    }

    /// @notice An order message is not a forward payload, and a forward payload is not an order —
    ///         they travel in different VAAs, and neither parses as the other.
    function testOrderAndForwardDoNotParseAsEachOther() public {
        bytes32 path = bytes32(uint256(0x0707070707070707070707070707070707070707070707070707070707070707));
        bytes memory order = codec.encodeOrder(path, _order());
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.MalformedForward.selector, 73));
        codec.decodeForward(order);
        assertTrue(codec.encodeForward(address(0xBEEF), 1).length != 73, "the router requires exactly 73 bytes");
    }

    function _head(bytes memory b, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = b[i];
        }
    }
}
