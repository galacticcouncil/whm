// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {BytesParsing} from "wormhole-solidity-sdk/libraries/BytesParsing.sol";

/// @title NttPayload — the fields an intent settlement is matched and sized on
/// @dev Mirrors `TransceiverStructs.parseTransceiverMessage` + `parseNttManagerMessage` +
///      `parseNativeTokenTransfer` from hydration-ntt at NTT_COMMIT
///      0f19d43f7ae88adf36e62364d4157db8da7a68ee, reading as far as the transfer's amount. Field by
///      field, using the same `BytesParsing` primitives NTT does, and in ONE pass — the sequence,
///      the digest preimage and the amount all come off the same walk.
library NttPayload {
    using BytesParsing for bytes;

    /// @notice The Wormhole transceiver's payload prefix.
    bytes4 internal constant WH_TRANSCEIVER_PAYLOAD_PREFIX = 0x9945FF10;

    /// @notice The `NativeTokenTransfer` prefix, inside the manager's message.
    bytes4 internal constant NTT_PREFIX = 0x994E5454;

    error InvalidPrefix(bytes4 prefix);
    error InvalidTransferPrefix(bytes4 prefix);

    /// @notice Everything a settlement is matched and sized on.
    /// @param payload A Wormhole transceiver VAA's payload.
    /// @return sequence The manager's sequence for this settlement — `NttManager.transfer`'s return
    ///         value, which the manager writes as `bytes32(uint256(sequence))`
    /// @return message The manager message, the preimage NTT digests delivery on
    /// @return decimals The precision `amount` carries. NTT trims to `min(8, srcDp, dstDp)`, so this
    ///         is not the token's own and the caller must scale by it
    /// @return amount What the transfer releases, trimmed to `decimals`
    function settlementOf(bytes memory payload)
        internal
        pure
        returns (uint64 sequence, bytes memory message, uint8 decimals, uint64 amount)
    {
        uint256 offset = 0;

        bytes4 prefix;
        (prefix, offset) = payload.asBytes4Unchecked(offset);
        if (prefix != WH_TRANSCEIVER_PAYLOAD_PREFIX) revert InvalidPrefix(prefix);

        (, offset) = payload.asBytes32Unchecked(offset); // sourceNttManagerAddress
        (, offset) = payload.asBytes32Unchecked(offset); // recipientNttManagerAddress

        uint16 length;
        (length, offset) = payload.asUint16Unchecked(offset);

        // Checked: the length prefix comes from bytes `parseVM` has not verified.
        (message,) = payload.slice(offset, length);

        bytes32 id;
        (id, offset) = payload.asBytes32Unchecked(offset);
        sequence = uint64(uint256(id));

        (, offset) = payload.asBytes32Unchecked(offset); // sender
        (, offset) = payload.asUint16Unchecked(offset); // transfer payload length

        bytes4 transferPrefix;
        (transferPrefix, offset) = payload.asBytes4Unchecked(offset);
        if (transferPrefix != NTT_PREFIX) revert InvalidTransferPrefix(transferPrefix);

        // Amount and decimals are encoded in reverse order to how `TrimmedAmount` declares them,
        // matching the Rust implementation — decimals first.
        (decimals, offset) = payload.asUint8Unchecked(offset);
        (amount, offset) = payload.asUint64Unchecked(offset);
    }
}
