// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {ScaleCodec} from "./ScaleCodec.sol";
import {Blake2b} from "./Blake2b.sol";

/// @title DerivedAccount - Compute XCM multilocation-derivative AccountKey20 addresses
/// @notice MDA derivation for AccountKey20
library DerivedAccount {
    uint8 constant PARENTS_CHILD = 0;
    uint8 constant PARENTS_SIBLING = 1;

    string constant FAMILY_CHILD = "ChildChain";
    string constant FAMILY_SIBLING = "SiblingChain";
    string constant FAMILY_PARENT = "ParentChain";

    string constant ACCOUNT_KEY20 = "AccountKey20";

    /// @notice Derive H160 for a sibling parachain sender (parents=1, parachainId defined)
    /// @param parachainId Source parachain ID (e.g. 2004 for Moonbeam)
    /// @param account     Source Ethereum address on the origin chain
    function deriveSibling(uint32 parachainId, address account) internal view returns (address) {
        return deriveMultilocationAccountKey20(PARENTS_SIBLING, parachainId, true, account);
    }

    /// @notice Derive H160 for a child parachain sender (parents=0, parachainId defined)
    function deriveChild(uint32 parachainId, address account) internal view returns (address) {
        return deriveMultilocationAccountKey20(PARENTS_CHILD, parachainId, true, account);
    }

    /// @notice Derive H160 for a parent chain sender (parents=1, no parachainId)
    function deriveParent(address account) internal view returns (address) {
        return deriveMultilocationAccountKey20(PARENTS_SIBLING, 0, false, account);
    }

    /// @notice MDA for AccountKey20 (Ethereum-style)
    /// @dev hash preimage: family ++ compact(para?) ++ compact(len("AccountKey20")+20) ++ "AccountKey20" ++ account
    function deriveMultilocationAccountKey20(uint8 parents, uint32 parachainId, bool hasParachainId, address account)
        internal
        view
        returns (address)
    {
        bytes32 hash = _deriveMultilocationHash(
            parents, parachainId, hasParachainId, ACCOUNT_KEY20, 32, abi.encodePacked(bytes20(account))
        );
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(bytes20(hash));
    }

    function _deriveMultilocationHash(
        uint8 parents,
        uint32 parachainId,
        bool hasParachainId,
        string memory accountType,
        uint32 encodedTypeAndAddressLen,
        bytes memory decodedAddress
    ) private view returns (bytes32) {
        bytes memory family = _family(parents, hasParachainId);
        bytes memory para = hasParachainId ? ScaleCodec.compactU32(parachainId) : bytes("");
        return Blake2b.blake2b256(
            abi.encodePacked(
                family, para, ScaleCodec.compactU32(encodedTypeAndAddressLen), bytes(accountType), decodedAddress
            )
        );
    }

    function _family(uint8 parents, bool hasParachainId) private pure returns (bytes memory) {
        if (parents == PARENTS_CHILD && hasParachainId) {
            return bytes(FAMILY_CHILD);
        }
        if (parents == PARENTS_SIBLING && !hasParachainId) {
            return bytes(FAMILY_PARENT);
        }
        return bytes(FAMILY_SIBLING);
    }
}
