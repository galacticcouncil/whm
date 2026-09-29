// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title GovernanceCodec — canonical Hydration cross-chain governance wire format
/// @notice Encodes and validates the exact ABI tuple signed by Wormhole. Decoding re-encodes the
///         result and compares it with the original bytes so alternate ABI representations cannot
///         identify the same executable action.
library GovernanceCodec {
    bytes6 internal constant MAGIC = 0x484458474f56; // "HDXGOV"
    uint8 internal constant VERSION = 1;

    uint256 internal constant MAX_CALLS = 16;
    uint256 internal constant MAX_CALL_DATA_LENGTH = 32_768;
    uint256 internal constant MAX_PAYLOAD_LENGTH = 65_536;

    bytes32 internal constant ACTION_DOMAIN =
        keccak256("hydration.cross-chain-governance.action.v1");

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    struct GovernanceAction {
        uint16 destinationWormholeChain;
        address destinationExecutor;
        uint64 governanceNonce;
        Call[] calls;
    }

    error InvalidMagic(bytes6 magic);
    error InvalidVersion(uint8 version);
    error InvalidDestinationChain();
    error InvalidDestinationExecutor();
    error InvalidGovernanceNonce();
    error InvalidCallCount(uint256 count);
    error InvalidCallTarget(uint256 index);
    error CallDataTooLarge(uint256 index, uint256 length);
    error PayloadTooLarge(uint256 length);
    error NonCanonicalPayload();

    /// @notice Encode and validate a new governance action.
    function encode(
        uint16 destinationWormholeChain,
        address destinationExecutor,
        uint64 governanceNonce,
        Call[] calldata calls
    ) internal pure returns (bytes memory payload) {
        _validateHeader(destinationWormholeChain, destinationExecutor, governanceNonce);
        _validateCalldataCalls(calls);

        payload = abi.encode(
            MAGIC,
            VERSION,
            destinationWormholeChain,
            destinationExecutor,
            governanceNonce,
            calls
        );
        if (payload.length > MAX_PAYLOAD_LENGTH) revert PayloadTooLarge(payload.length);
    }

    /// @notice Decode only the unique canonical representation of a valid v1 action.
    function decode(bytes memory payload) internal pure returns (GovernanceAction memory action) {
        if (payload.length > MAX_PAYLOAD_LENGTH) revert PayloadTooLarge(payload.length);

        bytes6 magic;
        uint8 version;
        (
            magic,
            version,
            action.destinationWormholeChain,
            action.destinationExecutor,
            action.governanceNonce,
            action.calls
        ) = abi.decode(payload, (bytes6, uint8, uint16, address, uint64, Call[]));

        if (magic != MAGIC) revert InvalidMagic(magic);
        if (version != VERSION) revert InvalidVersion(version);
        _validateHeader(
            action.destinationWormholeChain, action.destinationExecutor, action.governanceNonce
        );
        _validateMemoryCalls(action.calls);

        bytes memory canonical = abi.encode(
            MAGIC,
            VERSION,
            action.destinationWormholeChain,
            action.destinationExecutor,
            action.governanceNonce,
            action.calls
        );
        if (canonical.length != payload.length || keccak256(canonical) != keccak256(payload)) {
            revert NonCanonicalPayload();
        }
    }

    /// @notice Domain-separated identifier for a verified Wormhole message payload.
    function actionId(uint16 emitterChain, bytes32 emitterAddress, bytes32 payloadHash)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(ACTION_DOMAIN, emitterChain, emitterAddress, payloadHash));
    }

    function _validateHeader(
        uint16 destinationWormholeChain,
        address destinationExecutor,
        uint64 governanceNonce
    ) private pure {
        if (destinationWormholeChain == 0) revert InvalidDestinationChain();
        if (destinationExecutor == address(0)) revert InvalidDestinationExecutor();
        if (governanceNonce == 0) revert InvalidGovernanceNonce();
    }

    function _validateCalldataCalls(Call[] calldata calls) private pure {
        uint256 count = calls.length;
        if (count == 0 || count > MAX_CALLS) revert InvalidCallCount(count);

        for (uint256 i; i < count; ++i) {
            if (calls[i].target == address(0)) revert InvalidCallTarget(i);
            uint256 dataLength = calls[i].data.length;
            if (dataLength > MAX_CALL_DATA_LENGTH) revert CallDataTooLarge(i, dataLength);
        }
    }

    function _validateMemoryCalls(Call[] memory calls) private pure {
        uint256 count = calls.length;
        if (count == 0 || count > MAX_CALLS) revert InvalidCallCount(count);

        for (uint256 i; i < count; ++i) {
            if (calls[i].target == address(0)) revert InvalidCallTarget(i);
            uint256 dataLength = calls[i].data.length;
            if (dataLength > MAX_CALL_DATA_LENGTH) revert CallDataTooLarge(i, dataLength);
        }
    }
}
