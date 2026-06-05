// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {ScaleCodec} from "./ScaleCodec.sol";

/// @title XcmV4 — chain-agnostic XCM v4 SCALE primitives
/// @notice Version byte, instruction discriminants, and small encoders shared by every chain's
///         XCM call builders. Pin to v4;
library XcmV4 {
    uint8 internal constant VERSION = 4;

    // --- Instruction discriminants (v4) ---
    uint8 internal constant I_WITHDRAW_ASSET = 0;
    uint8 internal constant I_TRANSACT = 6;
    uint8 internal constant I_DEPOSIT_ASSET = 13;
    uint8 internal constant I_BUY_EXECUTION = 19;
    uint8 internal constant I_REFUND_SURPLUS = 20;

    // --- Enum bytes ---
    uint8 internal constant ORIGIN_KIND_SOVEREIGN = 1;
    uint8 internal constant TRANSFER_TYPE_DEST_RESERVE = 2;

    /// @dev VersionedLocation { parents: 1, interior: X1(Parachain(paraId)) }
    function versionedParachain(uint32 paraId) internal pure returns (bytes memory) {
        return abi.encodePacked(
            VERSION,
            uint8(0x01), // parents
            uint8(0x01), // interior: X1
            uint8(0x00), // Junction::Parachain
            ScaleCodec.compactU32(paraId)
        );
    }

    /// @dev Asset { id: Location(location), fun: Fungible(amount) }
    function fungible(bytes memory location, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(location, uint8(0x00), ScaleCodec.compactU128(uint128(amount)));
    }

    /// @dev Location { parents: 0, interior: X1(AccountKey20 { network: None, key }) }
    function accountKey20(address account) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(0x00), // parents
            uint8(0x01), // interior: X1
            uint8(0x03), // Junction::AccountKey20
            uint8(0x00), // network: Option::None
            bytes20(account)
        );
    }

    /// @dev DepositAsset { assets: Wild(AllCounted(count)), beneficiary }
    function depositAllCounted(uint32 count, bytes memory beneficiary) internal pure returns (bytes memory) {
        return abi.encodePacked(
            I_DEPOSIT_ASSET,
            uint8(0x01), // AssetFilter::Wild
            uint8(0x02), // WildAsset::AllCounted
            ScaleCodec.compactU32(count),
            beneficiary
        );
    }
}
