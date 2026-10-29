// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {IntentQuoteEmitter} from "../../src/intents/IntentQuoteEmitter.sol";
import {IntentCodec} from "../../src/intents/IntentCodec.sol";
import {IIntentQuoteEmitter} from "../../src/intents/interfaces/IIntentQuoteEmitter.sol";

contract MockCoreBridge {
    uint256 public fee;
    uint64 public nextSequence = 42;

    bytes public lastPayload;
    uint32 public lastNonce;
    uint8 public lastConsistency;
    uint256 public lastValue;

    function setFee(uint256 _fee) external {
        fee = _fee;
    }

    function messageFee() external view returns (uint256) {
        return fee;
    }

    function publishMessage(uint32 nonce, bytes memory payload, uint8 consistencyLevel)
        external
        payable
        returns (uint64 sequence)
    {
        lastNonce = nonce;
        lastPayload = payload;
        lastConsistency = consistencyLevel;
        lastValue = msg.value;

        sequence = nextSequence;
        nextSequence++;
    }
}

/// @dev The codec is a library, so its reverts are inlined into the caller rather than raised in a
///      subcall — `expectRevert` needs a real call frame to catch. This is that frame.
contract CodecHarness {
    function encode(IIntentQuoteEmitter.Quote calldata terms) external pure returns (bytes memory) {
        return IntentCodec.encodeQuote(terms);
    }

    function decode(bytes memory terms) external pure returns (IIntentQuoteEmitter.Quote memory) {
        return IntentCodec.decodeQuote(terms);
    }

    function encodeOrder(bytes32 path, IIntentQuoteEmitter.Order calldata o) external pure returns (bytes memory) {
        return IntentCodec.encodeOrder(path, o);
    }
}

/// @title IntentQuoteEmitterTest
/// @notice Pins the two wire formats NEAR's IntentRouter reads — the terms, hashed into the account
///         `A`, and the order message — to the router's own golden vectors, and the emitter's one
///         rule: only an authorized dispatcher publishes a price.
contract IntentQuoteEmitterTest is Test {
    IntentQuoteEmitter public emitter;
    MockCoreBridge public coreBridge;
    CodecHarness public codec;

    address constant DISPATCHER = address(0xD15);
    address constant STRANGER = address(0xBAD);

    string constant ZEC = "nep141:zec.omft.near";
    string constant T_ADDR = "t1KPVSRgnFHPBWMJLC7taJioN6m5Q6jVBma";

    /// @dev `terms.rs` `sample()` in the router — encoded by its Rust codec and by
    ///      `scripts/intent-router/shared.ts` `encodeTerms`, both to these bytes.
    bytes constant GOLDEN_TERMS =
        hex"011111111111111111111111111111111111111111111111111111111111111111006400000000000000000000000008f0d180000000000000000000000000000f4240000000006b49d200002222222222222222222222222222222222222222146e65703134313a7a65632e6f6d66742e6e6561722374314b50565352676e46485042574d4a4c433774614a696f4e366d3551366a56426d61";
    bytes32 constant GOLDEN_PATH = 0xa2159833cf7701b9e372725c6e640f1e922752118b6e5087dedbbb89b7a6d193;

    /// @dev `order.rs` `golden_vector()` in the router: path 0x07…07, seq 9, 0.001 ETH, 1.8 ZEC/ETH.
    bytes constant GOLDEN_ORDER =
        hex"0107070707070707070707070707070707070707070707070707070707070707070000000000000009000000000000000000038d7ea4c680000000000000000000000000000aba9500";

    function setUp() public {
        coreBridge = new MockCoreBridge();
        codec = new CodecHarness();
        emitter = IntentQuoteEmitter(
            address(
                new ERC1967Proxy(
                    address(new IntentQuoteEmitter()),
                    abi.encodeCall(IntentQuoteEmitter.initialize, (address(coreBridge)))
                )
            )
        );
        emitter.setDispatcher(DISPATCHER, true);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _terms() internal pure returns (IIntentQuoteEmitter.Quote memory) {
        return IIntentQuoteEmitter.Quote({
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

    function _order() internal pure returns (IIntentQuoteEmitter.Order memory) {
        return IIntentQuoteEmitter.Order({seq: 9, amount: 1e15, outPerIn: 180_000_000});
    }

    function _publish() internal returns (bytes32 path, uint64 sequence) {
        vm.prank(DISPATCHER);
        return emitter.publishOrder(_terms(), _order());
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
        assertEq(emitter.computeTerms(_terms()), GOLDEN_TERMS, "terms");
        assertEq(emitter.computeAuthPath(_terms()), GOLDEN_PATH, "path");
        assertEq(keccak256(GOLDEN_TERMS), GOLDEN_PATH, "path is keccak of the terms");
    }

    /// @notice The router decodes by offset, so the layout is read back field by field rather than
    ///         by re-encoding.
    function testTermsWireFormat() public view {
        bytes memory p = emitter.computeTerms(_terms());
        assertEq(_uint(p, 0, 1), 1, "version");
        assertEq(bytes32(_uint(p, 1, 32)), _terms().quoteId, "quoteId");
        assertEq(_uint(p, 33, 2), 100, "maxSlippageBps");
        assertEq(_uint(p, 35, 16), 150_000_000, "minOutPerIn");
        assertEq(_uint(p, 51, 16), 1_000_000, "minDelivery");
        assertEq(_uint(p, 67, 8), 1_800_000_000, "deadline");
        assertEq(_uint(p, 75, 1), 0, "recipientKind");
        assertEq(address(uint160(_uint(p, 76, 20))), address(0x2222222222222222222222222222222222222222), "refundTo");

        uint256 assetLen = _uint(p, 96, 1);
        assertEq(_str(p, 97, assetLen), ZEC, "destinationAsset");
        uint256 recipientLen = _uint(p, 97 + assetLen, 1);
        assertEq(_str(p, 98 + assetLen, recipientLen), T_ADDR, "recipient");
        // Declared lengths account for the whole buffer — a payload the router could truncate
        // rather than reject would have a second reading.
        assertEq(p.length, 98 + assetLen + recipientLen, "trailing bytes");
    }

    function testTermsRoundTripThroughTheDecoder() public view {
        IIntentQuoteEmitter.Quote memory t = codec.decode(GOLDEN_TERMS);
        assertEq(abi.encode(t), abi.encode(_terms()), "round trip");
    }

    /// @notice Each check the router's parser makes, made by the encoder first — terms it accepts
    ///         but the router rejects would leave their account unable even to refund.
    function testEncoderRejectsWhatTheRouterRejects() public {
        IIntentQuoteEmitter.Quote memory t = _terms();

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
        IIntentQuoteEmitter.Quote memory t = _terms();
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
        bytes32 base = emitter.computeAuthPath(_terms());
        IIntentQuoteEmitter.Quote memory t;

        t = _terms(); t.maxSlippageBps = 99;
        assertTrue(emitter.computeAuthPath(t) != base, "slippage");
        t = _terms(); t.minOutPerIn = 1;
        assertTrue(emitter.computeAuthPath(t) != base, "hard floor");
        t = _terms(); t.minDelivery = 1;
        assertTrue(emitter.computeAuthPath(t) != base, "minDelivery");
        t = _terms(); t.deadline = 1;
        assertTrue(emitter.computeAuthPath(t) != base, "deadline");
        t = _terms(); t.refundTo = address(0x3333);
        assertTrue(emitter.computeAuthPath(t) != base, "refundTo");
        t = _terms(); t.recipient = "t1KPVSRgnFHPBWMJLC7taJioN6m5Q6jVBmb";
        assertTrue(emitter.computeAuthPath(t) != base, "recipient");
    }

    /// @notice The length bytes keep field boundaries unambiguous: moving a byte between the two
    ///         strings changes the path.
    function testPathIsUnambiguousAcrossFieldBoundaries() public view {
        IIntentQuoteEmitter.Quote memory a = _terms();
        a.destinationAsset = "nep141:a";
        a.recipient = "bc";
        IIntentQuoteEmitter.Quote memory b = _terms();
        b.destinationAsset = "nep141:ab";
        b.recipient = "c";
        assertTrue(emitter.computeAuthPath(a) != emitter.computeAuthPath(b));
    }

    // ─── Orders ─────────────────────────────────────────────────────

    function testOrderMatchesTheRoutersGoldenVector() public view {
        bytes32 path = bytes32(uint256(0x0707070707070707070707070707070707070707070707070707070707070707));
        assertEq(codec.encodeOrder(path, _order()), GOLDEN_ORDER);
    }

    function testPublishOrder() public {
        vm.expectEmit(true, true, false, true, address(emitter));
        emit IIntentQuoteEmitter.OrderPublished(GOLDEN_PATH, 9, DISPATCHER, 1e15, 180_000_000, 42, GOLDEN_TERMS);
        (bytes32 path, uint64 sequence) = _publish();

        assertEq(path, GOLDEN_PATH, "path");
        assertEq(sequence, 42, "sequence");
        assertEq(coreBridge.lastPayload(), abi.encodePacked(uint8(1), GOLDEN_PATH, uint64(9), uint128(1e15), uint128(180_000_000)));
        assertEq(coreBridge.lastPayload().length, 73, "order size");
        assertEq(coreBridge.lastConsistency(), 202, "finalized");
        assertEq(emitter.nonce(), 1, "nonce");
    }

    /// @notice A price is an authority over every path: only an authorized dispatcher sets one.
    function testOnlyADispatcherPublishes() public {
        vm.prank(STRANGER);
        vm.expectRevert(IIntentQuoteEmitter.NotDispatcher.selector);
        emitter.publishOrder(_terms(), _order());

        emitter.setDispatcher(DISPATCHER, false);
        vm.prank(DISPATCHER);
        vm.expectRevert(IIntentQuoteEmitter.NotDispatcher.selector);
        emitter.publishOrder(_terms(), _order());
    }

    function testRejectsAZeroRate() public {
        IIntentQuoteEmitter.Order memory o = _order();
        o.outPerIn = 0;
        vm.prank(DISPATCHER);
        vm.expectRevert(IIntentQuoteEmitter.ZeroRate.selector);
        emitter.publishOrder(_terms(), o);
    }

    function testInvalidTermsAreNeverPublished() public {
        IIntentQuoteEmitter.Quote memory t = _terms();
        t.refundTo = address(0);
        vm.prank(DISPATCHER);
        vm.expectRevert(IntentCodec.InvalidRefundTo.selector);
        emitter.publishOrder(t, _order());
    }

    /// @notice Native is WETH on Hydration: an approximate fee would be paid out of someone's funds.
    function testRequiresTheExactMessageFee() public {
        coreBridge.setFee(7);
        vm.deal(DISPATCHER, 10);

        vm.prank(DISPATCHER);
        vm.expectRevert(abi.encodeWithSelector(IIntentQuoteEmitter.InvalidMessageFee.selector, 7, 8));
        emitter.publishOrder{value: 8}(_terms(), _order());

        vm.prank(DISPATCHER);
        emitter.publishOrder{value: 7}(_terms(), _order());
        assertEq(coreBridge.lastValue(), 7);
    }

    // ─── Admin ──────────────────────────────────────────────────────

    function testOnlyTheOwnerAuthorizes() public {
        vm.prank(STRANGER);
        vm.expectRevert(IIntentQuoteEmitter.NotOwner.selector);
        emitter.setDispatcher(STRANGER, true);
    }

    function testOnlyTheOwnerUpgrades() public {
        address impl = address(new IntentQuoteEmitter());
        vm.prank(STRANGER);
        vm.expectRevert(IIntentQuoteEmitter.NotOwner.selector);
        emitter.upgradeToAndCall(impl, "");
    }
}
