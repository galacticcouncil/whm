// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IIntentDispatcher} from "./interfaces/IIntentDispatcher.sol";

/// @title IntentCodec — the terms, order and forward wire formats
/// @notice Packed big-endian, because the decoder is Rust (crates/near/contracts/intent-router,
///         `terms.rs` and `order.rs`). Checks mirror the router's parser exactly: terms this encoder
///         accepts must parse there, or their account could not even refund. Layouts and rationale:
///         docs/intents-v2/schema.md §2–3.
///
///         Terms:
///           offset  size  field              offset  size  field
///                0     1  version                87     8  deadline
///                1    20  owner                  95     1  recipientKind
///               21    32  quoteId                96    20  refundTo
///               53     2  maxSlippageBps        116     1  destAssetLen (D)
///               55    16  minOutPerIn           117     D  destinationAsset
///               71    16  minDelivery         117+D     1  recipientLen (R)
///                                             118+D     R  recipient       total 118 + D + R
///
///         Order message: msgType 1 | authPath 32 | seq 8 | amount 16 | outPerIn 16 — 73 bytes.
///
///         Forward payload, in the NTT transfer's `additionalPayload`:
///           version 1 | depositAddress 20 | maxRelayFee 16 — 37 bytes.
library IntentCodec {
    /// @notice The limit swap — the only strategy. Inside the hash, so a future layout derives
    ///         disjoint accounts.
    uint8 internal constant VERSION = 1;

    /// @notice `recipient` is an address on the destination chain; the router withdraws through POA.
    uint8 internal constant KIND_WITHDRAW = 0;

    /// @notice `recipient` is a NEAR intents account; the funds stay on NEAR.
    uint8 internal constant KIND_INTENTS_ACCOUNT = 1;

    /// @notice Basis points in 1.
    uint16 internal constant BPS = 10_000;

    /// @notice The order message's type byte.
    uint8 internal constant MSG_ORDER = 1;

    /// @dev Fixed prefix through `destAssetLen`, i.e. everything before the first string.
    uint256 internal constant TERMS_HEADER_SIZE = 117;

    uint256 internal constant ORDER_SIZE = 73;

    /// @notice The forward payload's version.
    uint8 internal constant FORWARD_VERSION = 1;

    uint256 internal constant FORWARD_SIZE = 37;

    error InvalidOwner();
    error InvalidQuoteId();
    error InvalidSlippage(uint16 bps);
    error InvalidDeadline();
    error InvalidRecipientKind(uint8 kind);
    error InvalidRefundTo();
    error InvalidDestinationAsset(uint256 length);
    error InvalidRecipient(uint256 length);
    error InvalidVersion(uint8 version);
    /// @dev Declared lengths do not account for the buffer exactly.
    error MalformedTerms(uint256 length);
    /// @dev Not a 37-byte payload of the forward version.
    error MalformedForward(uint256 length);
    /// @dev A relay ceiling wider than the payload's 16 bytes.
    error InvalidRelayFee(uint256 maxRelayFee);

    // ─── Terms ───────────────────────────────────────────────────

    /// @notice The MPC derivation path a set of terms hashes to.
    function authPath(IIntentDispatcher.Quote memory t) internal pure returns (bytes32) {
        return keccak256(encodeQuote(t));
    }

    /// @notice Encode a set of terms — the exact bytes published, and the preimage of their path.
    /// @dev Every check the router's parser makes, made here first. Length bounds belong to the
    ///      encoder, so no caller can obtain an ambiguous hash: over 255 wraps to zero through the
    ///      `uint8` cast.
    function encodeQuote(IIntentDispatcher.Quote memory t) internal pure returns (bytes memory) {
        bytes memory asset = bytes(t.destinationAsset);
        bytes memory recipient = bytes(t.recipient);

        if (t.owner == address(0)) revert InvalidOwner();
        if (t.quoteId == bytes32(0)) revert InvalidQuoteId();
        if (t.maxSlippageBps >= BPS) revert InvalidSlippage(t.maxSlippageBps);
        if (t.deadline == 0) revert InvalidDeadline();
        if (t.recipientKind > KIND_INTENTS_ACCOUNT) revert InvalidRecipientKind(t.recipientKind);
        if (t.refundTo == address(0)) revert InvalidRefundTo();
        if (!_printable(asset)) revert InvalidDestinationAsset(asset.length);
        if (!_printable(recipient)) revert InvalidRecipient(recipient.length);

        // Two halves, or the packing runs out of stack: the fixed fields, then the two strings.
        return bytes.concat(
            abi.encodePacked(
                VERSION,
                t.owner,
                t.quoteId,
                t.maxSlippageBps,
                t.minOutPerIn,
                t.minDelivery,
                t.deadline,
                t.recipientKind,
                t.refundTo
            ),
            abi.encodePacked(uint8(asset.length), asset, uint8(recipient.length), recipient)
        );
    }

    /// @notice Parse encoded terms back — the mirror of the router's decoder, for tests and tools.
    /// @dev Rejects rather than truncates: a buffer two different sets of terms could hash from is
    ///      not one to read the first of.
    function decodeQuote(bytes memory terms) internal pure returns (IIntentDispatcher.Quote memory t) {
        if (terms.length < TERMS_HEADER_SIZE) revert MalformedTerms(terms.length);
        if (uint8(terms[0]) != VERSION) revert InvalidVersion(uint8(terms[0]));

        uint256 assetLen = uint8(terms[116]);
        uint256 recipientLenOffset = TERMS_HEADER_SIZE + assetLen;
        if (terms.length <= recipientLenOffset) revert MalformedTerms(terms.length);

        uint256 recipientLen = uint8(terms[recipientLenOffset]);
        // Read the second length only after the first string, and hold the total to both.
        if (terms.length != recipientLenOffset + 1 + recipientLen) revert MalformedTerms(terms.length);

        t = IIntentDispatcher.Quote({
            owner: address(uint160(_uint(terms, 1, 20))),
            quoteId: bytes32(_uint(terms, 21, 32)),
            maxSlippageBps: uint16(_uint(terms, 53, 2)),
            minOutPerIn: uint128(_uint(terms, 55, 16)),
            minDelivery: uint128(_uint(terms, 71, 16)),
            deadline: uint64(_uint(terms, 87, 8)),
            recipientKind: uint8(terms[95]),
            refundTo: address(uint160(_uint(terms, 96, 20))),
            destinationAsset: string(_slice(terms, TERMS_HEADER_SIZE, assetLen)),
            recipient: string(_slice(terms, recipientLenOffset + 1, recipientLen))
        });

        if (t.owner == address(0)) revert InvalidOwner();
        if (t.quoteId == bytes32(0)) revert InvalidQuoteId();
        if (t.maxSlippageBps >= BPS) revert InvalidSlippage(t.maxSlippageBps);
        if (t.deadline == 0) revert InvalidDeadline();
        if (t.recipientKind > KIND_INTENTS_ACCOUNT) revert InvalidRecipientKind(t.recipientKind);
        if (t.refundTo == address(0)) revert InvalidRefundTo();
        if (!_printable(bytes(t.destinationAsset))) revert InvalidDestinationAsset(assetLen);
        if (!_printable(bytes(t.recipient))) revert InvalidRecipient(recipientLen);
    }

    // ─── Order ───────────────────────────────────────────────────

    /// @notice The order message: what the router reads to price one fill of the path's account.
    function encodeOrder(bytes32 path, IIntentDispatcher.Order memory o) internal pure returns (bytes memory) {
        return abi.encodePacked(MSG_ORDER, path, o.seq, o.amount, o.outPerIn);
    }

    // ─── Forward ─────────────────────────────────────────────────

    /// @notice The forwarding instruction the Ethereum forwarder reads from the NTT transfer.
    function encodeForward(address depositAddress, uint256 maxRelayFee) internal pure returns (bytes memory) {
        if (maxRelayFee > type(uint128).max) revert InvalidRelayFee(maxRelayFee);
        return abi.encodePacked(FORWARD_VERSION, depositAddress, uint128(maxRelayFee));
    }

    /// @notice Parse a forward payload — exactly 37 bytes of the forward version, or nothing.
    function decodeForward(bytes memory payload) internal pure returns (address depositAddress, uint256 maxRelayFee) {
        if (payload.length != FORWARD_SIZE || uint8(payload[0]) != FORWARD_VERSION) {
            revert MalformedForward(payload.length);
        }
        depositAddress = address(uint160(_uint(payload, 1, 20)));
        maxRelayFee = _uint(payload, 21, 16);
    }

    // ─── Helpers ─────────────────────────────────────────────────

    /// @dev 1..255 bytes, every one visible ASCII — no spaces, no control characters. Both strings
    ///      end up in a withdrawal memo or an intents id.
    function _printable(bytes memory s) private pure returns (bool) {
        if (s.length == 0 || s.length > 255) return false;
        for (uint256 i = 0; i < s.length; i++) {
            uint8 c = uint8(s[i]);
            if (c < 0x21 || c > 0x7e) return false;
        }
        return true;
    }

    /// @dev `size` big-endian bytes at `offset`, as an integer.
    function _uint(bytes memory data, uint256 offset, uint256 size) private pure returns (uint256 v) {
        for (uint256 i = 0; i < size; i++) {
            v = (v << 8) | uint8(data[offset + i]);
        }
    }

    /// @dev Solidity has no slice for `bytes memory`.
    function _slice(bytes memory data, uint256 offset, uint256 length) private pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = data[offset + i];
        }
    }
}
