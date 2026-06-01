// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {ScaleCodec} from "./ScaleCodec.sol";

/// @title MrlPayload - SCALE-encode MRL (Moonbeam Routed Liquidity) payloads
/// @notice Encodes VersionedUserAction::V1 { destination: XcmVersionedLocation::V5 }
///         for routing transfers to a parachain recipient via XCM
library MrlPayload {
    uint8 constant VERSIONED_USER_ACTION_V1 = 0x00;
    uint8 constant XCM_VERSION_V5 = 0x05;
    uint8 constant JUNCTIONS_X2 = 0x02;

    uint8 constant JUNCTION_PARACHAIN = 0x00;
    uint8 constant JUNCTION_ACCOUNT_ID32 = 0x01;
    uint8 constant JUNCTION_ACCOUNT_KEY20 = 0x03;

    /// @notice Encode payload for AccountId32 recipient (Substrate-style)
    /// @param parachainId Destination parachain ID (e.g. 2034 for Hydration)
    /// @param accountId32 32-byte Substrate account ID
    function encode(uint32 parachainId, bytes32 accountId32) internal pure returns (bytes memory) {
        return abi.encodePacked(
            VERSIONED_USER_ACTION_V1,
            XCM_VERSION_V5,
            uint8(0x01), // parents: 1
            JUNCTIONS_X2,
            JUNCTION_PARACHAIN,
            ScaleCodec.compactU32(parachainId),
            JUNCTION_ACCOUNT_ID32,
            ScaleCodec.encodeNone(), // network: None
            accountId32
        );
    }

    /// @notice Encode payload for AccountKey20 recipient (Ethereum-style)
    /// @param parachainId Destination parachain ID (e.g. 2034 for Hydration)
    /// @param account 20-byte Ethereum address
    function encodeEth(uint32 parachainId, address account) internal pure returns (bytes memory) {
        return abi.encodePacked(
            VERSIONED_USER_ACTION_V1,
            XCM_VERSION_V5,
            uint8(0x01), // parents: 1
            JUNCTIONS_X2,
            JUNCTION_PARACHAIN,
            ScaleCodec.compactU32(parachainId),
            JUNCTION_ACCOUNT_KEY20,
            ScaleCodec.encodeNone(), // network: None
            bytes20(account)
        );
    }
}
