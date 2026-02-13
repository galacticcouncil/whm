// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {XcmTransactor} from "../src/XcmTransactor.sol";
import {DerivedAccount} from "../src/utils/DerivedAccount.sol";

contract XcmTransactorTest is Test {
    XcmTransactor public transactor;

    uint32 constant HYDRATION_PARA_ID = 2034;
    uint32 constant SOURCE_PARA_ID = 2004;
    uint8 constant EVM_PALLET_INDEX = 36;
    uint8 constant EVM_CALL_INDEX = 0;

    function setUp() public {
        XcmTransactor impl = new XcmTransactor(HYDRATION_PARA_ID, SOURCE_PARA_ID, EVM_PALLET_INDEX, EVM_CALL_INDEX);
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), abi.encodeCall(XcmTransactor.initialize, ()));
        transactor = XcmTransactor(address(proxy));
        transactor.setAuthorized(address(this), true);
    }

    function testOnlyAuthorizedCanTransact() public {
        vm.prank(address(0xdead));
        vm.expectRevert(XcmTransactor.NotAuthorized.selector);
        transactor.transact(address(0xBEEF), hex"");
    }

    function testOnlyOwnerCanSetAuthorized() public {
        vm.prank(address(0xdead));
        vm.expectRevert(XcmTransactor.NotOwner.selector);
        transactor.setAuthorized(address(0xCAFE), true);
    }

    function testSetAuthorized() public {
        transactor.setAuthorized(address(0xCAFE), true);
        assertTrue(transactor.authorized(address(0xCAFE)));

        transactor.setAuthorized(address(0xCAFE), false);
        assertFalse(transactor.authorized(address(0xCAFE)));
    }

    function testOnlyAuthorizedCanSetDefaults() public {
        vm.prank(address(0xdead));
        vm.expectRevert(XcmTransactor.NotAuthorized.selector);
        transactor.setXcmDefaults(0, 0, 0, 0, 0);
    }

    function testSetXcmDefaults() public {
        transactor.setXcmDefaults(500_000, 2e9, 400_000_000, 8_000_000_000, 2e12);
        assertEq(transactor.xcmGasLimit(), 500_000);
        assertEq(transactor.xcmMaxFeePerGas(), 2e9);
    }

    function testImmutableConfig() public view {
        assertEq(transactor.HYDRATION_PARA_ID(), HYDRATION_PARA_ID);
        assertEq(transactor.SOURCE_PARA_ID(), SOURCE_PARA_ID);
        assertEq(transactor.EVM_PALLET_INDEX(), EVM_PALLET_INDEX);
        assertEq(transactor.EVM_CALL_INDEX(), EVM_CALL_INDEX);
    }

    function testSetXcmSourceUsesDerivedAccount() public view {
        assertEq(transactor.xcmSource(), DerivedAccount.deriveSibling(SOURCE_PARA_ID, address(transactor)));
    }
}
