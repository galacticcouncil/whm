// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {DerivedAccount} from "../../src/utils/DerivedAccount.sol";

contract DerivedAccountHarness {
    function deriveSibling(uint32 parachainId, address account) external view returns (address) {
        return DerivedAccount.deriveSibling(parachainId, account);
    }

    function deriveChild(uint32 parachainId, address account) external view returns (address) {
        return DerivedAccount.deriveChild(parachainId, account);
    }

    function deriveParent(address account) external view returns (address) {
        return DerivedAccount.deriveParent(account);
    }

    function deriveMultilocationAccountKey20(uint8 parents, uint32 parachainId, bool hasParachainId, address account)
        external
        view
        returns (address)
    {
        return DerivedAccount.deriveMultilocationAccountKey20(parents, parachainId, hasParachainId, account);
    }

    function deriveSiblingEvm(uint32 parachainId, address account) external view returns (address) {
        return DerivedAccount.deriveSiblingEvm(parachainId, account);
    }

    function deriveMultilocationAccountId32(uint8 parents, uint32 parachainId, bool hasParachainId, bytes32 account)
        external
        view
        returns (address)
    {
        return DerivedAccount.deriveMultilocationAccountId32(parents, parachainId, hasParachainId, account);
    }
}

contract DerivedAccountTest is Test {
    struct MatrixCase {
        uint8 parents;
        uint32 parachainId;
        bool hasParachainId;
        address account;
        address expected;
    }

    DerivedAccountHarness internal harness;

    address internal constant ACCOUNT_1 = 0x1111111111111111111111111111111111111111;
    address internal constant ACCOUNT_2 = 0x0123456789abcDEF0123456789abCDef01234567;

    function setUp() public {
        harness = new DerivedAccountHarness();
    }

    function testDeriveMultilocationAccountKey20Matrix() public view {
        MatrixCase[] memory cases = new MatrixCase[](9);

        cases[0] = MatrixCase({
            parents: 1,
            parachainId: 2004,
            hasParachainId: true,
            account: ACCOUNT_1,
            expected: 0xd10E63A07Caecc34ECDf3752bb986DF685566E81
        }); // sibling
        cases[1] = MatrixCase({
            parents: 0,
            parachainId: 2004,
            hasParachainId: true,
            account: ACCOUNT_1,
            expected: 0xea0757294a49523365f2B10839d51d3C73483F5A
        }); // child
        cases[2] = MatrixCase({
            parents: 1,
            parachainId: 0,
            hasParachainId: false,
            account: ACCOUNT_1,
            expected: 0xfaE11Aee3B6bf324e115102c0b277351E28b8BE3
        }); // parent
        cases[3] = MatrixCase({
            parents: 0,
            parachainId: 0,
            hasParachainId: false,
            account: ACCOUNT_1,
            expected: 0x08F5427b63201853Aa9419fB0Fa8f4C37A3f8560
        }); // default sibling
        cases[4] = MatrixCase({
            parents: 2,
            parachainId: 2034,
            hasParachainId: true,
            account: ACCOUNT_1,
            expected: 0xF81D57976017DbBa8e1248c996b50D0D8461Cfa4
        }); // default sibling
        cases[5] = MatrixCase({
            parents: 2,
            parachainId: 0,
            hasParachainId: false,
            account: ACCOUNT_1,
            expected: 0x08F5427b63201853Aa9419fB0Fa8f4C37A3f8560
        }); // default sibling
        cases[6] = MatrixCase({
            parents: 1,
            parachainId: 1000,
            hasParachainId: true,
            account: ACCOUNT_2,
            expected: 0x8953aD425c2cF3ccc42b0d3f0e65855317737a06
        }); // sibling
        cases[7] = MatrixCase({
            parents: 0,
            parachainId: 1000,
            hasParachainId: true,
            account: ACCOUNT_2,
            expected: 0x84B54F7be0eE0E3f0526220db2bfe1Fd824AC73C
        }); // child
        cases[8] = MatrixCase({
            parents: 1,
            parachainId: 0,
            hasParachainId: false,
            account: ACCOUNT_2,
            expected: 0x40E6329D52Bdd5DB9ae73B4964eb2f709855148C
        }); // parent

        for (uint256 i = 0; i < cases.length; i++) {
            MatrixCase memory c = cases[i];
            address got = harness.deriveMultilocationAccountKey20(c.parents, c.parachainId, c.hasParachainId, c.account);
            assertEq(got, c.expected);
        }
    }

    function testHelpersMatchGeneric() public view {
        address sibling = harness.deriveSibling(2004, ACCOUNT_1);
        address child = harness.deriveChild(2004, ACCOUNT_1);
        address parent = harness.deriveParent(ACCOUNT_1);

        assertEq(sibling, harness.deriveMultilocationAccountKey20(1, 2004, true, ACCOUNT_1));
        assertEq(child, harness.deriveMultilocationAccountKey20(0, 2004, true, ACCOUNT_1));
        assertEq(parent, harness.deriveMultilocationAccountKey20(1, 0, false, ACCOUNT_1));
    }

    function testParachainIdIgnoredWhenHasParachainIdFalse() public view {
        address a = harness.deriveMultilocationAccountKey20(1, 0, false, ACCOUNT_1);
        address b = harness.deriveMultilocationAccountKey20(1, 2034, false, ACCOUNT_1);
        assertEq(a, b);
    }

    /// @dev An unbound EVM address on a Substrate chain (e.g. Hydration) descends to a sibling as its
    ///      truncated EVM account (AccountId32 "ETH\0"++h160++0×8), so its MDA is the AccountId32 derivation
    ///      — NOT the AccountKey20 one used for AccountId20 chains (Moonbeam). The scheme was cross-checked
    ///      against a real Hydration(2034)→Moonbeam MDA pair; this pins it as a deterministic regression vector.
    function testDeriveSiblingEvmIsAccountId32Derivation() public view {
        bytes32 id = bytes32(abi.encodePacked(bytes4(0x45544800), bytes20(ACCOUNT_2), bytes8(0)));
        assertEq(harness.deriveSiblingEvm(2034, ACCOUNT_2), harness.deriveMultilocationAccountId32(1, 2034, true, id));
        assertEq(harness.deriveSiblingEvm(2034, ACCOUNT_2), 0x631a0cb3459e79c9E972A6e0a9eaC7F4D7C5eDd6);
        assertTrue(harness.deriveSiblingEvm(2034, ACCOUNT_2) != harness.deriveSibling(2034, ACCOUNT_2));
    }
}
