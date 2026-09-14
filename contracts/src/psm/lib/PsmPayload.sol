// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PsmPayload — the PSM wire format
/// @notice Fixed-width, byte-packed body carried inside a Wormhole VAA payload. Both ends of the
///         corridor decode with this library, so the format has exactly one definition.
///
/// @dev Layout, 98 bytes, big-endian:
///
///        ┌───────┬───────┬──────────────────────────┬──────────────────────────┬──────────────────────────┐
///        │  [0]  │  [1]  │         [2 .. 34)        │        [34 .. 66)        │        [66 .. 98)        │
///        │ uint8 │ uint8 │          bytes32         │          uint256         │          bytes32         │
///        │version│ kind  │ recipient — left-pad H160│ amount — USDC units, 6dp │  origin — left-pad H160  │
///        └───────┴───────┴──────────────────────────┴──────────────────────────┴──────────────────────────┘
///
///      **`origin` is the account that signed the originating transaction on the source chain**:
///      the depositor on Base, the redeemer on Hydration. It is the one address guaranteed to
///      exist there, so it is where a cancellation on the far side sends the value back. A
///      cancellation swaps the pair: the message it publishes is addressed to the old `origin`,
///      and names the old `recipient` as its own origin.
///
///      **The wire always carries USDC units, never HOLLAR units.** USDC is the lower precision
///      of the pair, so quoting the coarser unit makes conversion lossless in both directions and
///      makes dust structurally impossible: Hydration only ever multiplies by `scale`, and a
///      redeem denominated in USDC units burns an exact multiple of `scale` by construction.
///
///      **Packed, not `abi.encode`.** A fixed-width body with a leading version byte is
///      append-only by construction and is dispatchable before it is parsed. `abi.encode` of an
///      evolving struct is not decode-compatible across revisions, and VAAs are permanent, so a
///      shape change would strand every unrelayed message.
library PsmPayload {
    // ─── Constants ──────────────────────────────────────────────

    /// @notice Wire version. An unrecognised version is refused, never parsed and never treated
    ///         as empty: an unparsed message must never mint.
    uint8 internal constant VERSION = 1;

    /// @notice Base to Hydration: a deposit was locked, mint against it.
    uint8 internal constant KIND_MINT = 1;
    /// @notice Hydration to Base: HOLLAR was burned, credit the redemption.
    uint8 internal constant KIND_REDEEM = 2;
    /// @notice Hydration to Base: a queued mint was cancelled, credit it back with no fee.
    uint8 internal constant KIND_REFUND = 3;
    /// @notice Base to Hydration: a queued redemption was cancelled, re-mint what was burned. Handled
    ///         exactly like a mint — bucket-checked and charged to the inbound window — and kept as
    ///         its own kind only so a cancel is distinguishable from a deposit on the wire.
    uint8 internal constant KIND_REMINT = 4;

    /// @notice Exact encoded length. Anything else is refused rather than padded or truncated.
    uint256 internal constant LENGTH = 98;

    // ─── Errors ─────────────────────────────────────────────────

    error InvalidLength(uint256 got);
    error UnsupportedVersion(uint8 got);
    error UnknownKind(uint8 got);
    error NotAnAddress(bytes32 raw);
    error ZeroRecipient();

    // ─── Encode ─────────────────────────────────────────────────

    /// @notice Pack a body for publishing. Callers are responsible for having validated the
    ///         recipient on the source chain, where the user still holds their funds.
    function encode(uint8 kind, bytes32 recipient, uint256 amount, bytes32 origin)
        internal
        pure
        returns (bytes memory)
    {
        if (!_knownKind(kind)) revert UnknownKind(kind);
        return abi.encodePacked(VERSION, kind, recipient, amount, origin);
    }

    // ─── Decode ─────────────────────────────────────────────────

    /// @notice Parse a body. Validates length, version and kind, and nothing else.
    /// @dev The recipient is deliberately **not** validated here. Converting it is the caller's
    ///      step, via `toAddress`, because the two sides want different behaviour: the vault
    ///      rejects a bad recipient at `deposit` while the user still holds their money, whereas
    ///      the facilitator must not revert on a valid VAA. Keeping the check out of `decode`
    ///      stops it becoming an unconditional revert on the receiving side.
    function decode(bytes memory body)
        internal
        pure
        returns (uint8 kind, bytes32 recipient, uint256 amount, bytes32 origin)
    {
        if (body.length != LENGTH) revert InvalidLength(body.length);

        uint8 version;
        bytes32 rawOrigin; // `origin` is a Yul builtin, so it cannot be assigned inside assembly
        assembly {
            // body content starts at body+0x20; read the two leading bytes from the high end of
            // the first word, then the three 32-byte fields at their offsets.
            let word := mload(add(body, 0x20))
            version := byte(0, word)
            kind := byte(1, word)
            recipient := mload(add(body, 0x22))
            amount := mload(add(body, 0x42))
            rawOrigin := mload(add(body, 0x62))
        }
        origin = rawOrigin;

        if (version != VERSION) revert UnsupportedVersion(version);
        if (!_knownKind(kind)) revert UnknownKind(kind);
    }

    function _knownKind(uint8 kind) private pure returns (bool) {
        return kind >= KIND_MINT && kind <= KIND_REMINT;
    }

    // ─── Address conversion ─────────────────────────────────────

    /// @notice Convert a 32-byte universal address to an H160, refusing anything that is not one.
    /// @dev Two refusals, both load-bearing. **Non-zero high twelve bytes are rejected, never
    ///      truncated**, because truncation lets a sender choose two distinct 32-byte values that
    ///      resolve to one account. **Zero is rejected** because a zero recipient is an
    ///      unrecoverable payout: HOLLAR minted to the zero address, or USDC credited to it, is
    ///      gone with no owner to claim it.
    function toAddress(bytes32 raw) internal pure returns (address) {
        if (uint256(raw) >> 160 != 0) revert NotAnAddress(raw);
        if (raw == bytes32(0)) revert ZeroRecipient();
        return address(uint160(uint256(raw)));
    }

    /// @notice Left-pad an H160 into the 32-byte universal form.
    function fromAddress(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
