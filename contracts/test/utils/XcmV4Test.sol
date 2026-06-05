// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {XcmV4} from "../../src/utils/XcmV4.sol";

/// @notice Byte-level checks for the generic XCM v4 primitives.
contract XcmV4Test is Test {
    // VersionedLocation V4 { parents:1, X1(Parachain(2004)) }
    function test_versionedParachain() public pure {
        assertEq(XcmV4.versionedParachain(2004), hex"04010100511f");
    }

    // Location { parents:0, X1(AccountKey20 { None, MDA }) }
    function test_accountKey20() public pure {
        assertEq(
            XcmV4.accountKey20(0x5DAC9319aAf8a18cF60Ad5b94f8daB3232ac9FfC),
            abi.encodePacked(hex"00010300", bytes20(0x5DAC9319aAf8a18cF60Ad5b94f8daB3232ac9FfC))
        );
    }

    // Asset { id: GLMR_LOCAL, fun: Fungible(1) }  (compact 1 = 0x04)
    function test_fungible_smallAmount() public pure {
        assertEq(XcmV4.fungible(hex"0001040a", 1), hex"0001040a" hex"00" hex"04");
    }

    // DepositAsset { Wild(AllCounted(2)), beneficiary }  → 0d 01 02 08(compact 2) ++ beneficiary
    function test_depositAllCounted() public pure {
        bytes memory ben = hex"00010300aabbccddeeff00112233445566778899aabbccdd";
        assertEq(XcmV4.depositAllCounted(2, ben), abi.encodePacked(hex"0d010208", ben));
    }
}
