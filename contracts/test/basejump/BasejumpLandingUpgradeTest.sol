// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {BasejumpLanding} from "../../src/basejump/BasejumpLanding.sol";
import {IBasejumpLanding} from "../../src/basejump/interfaces/IBasejumpLanding.sol";

import {BasejumpLandingV1} from "./BasejumpLandingV1.sol";
import {MockERC20} from "./BasejumpLandingTest.sol";

/// @dev Records the order of recipients the dispatch precompile is asked to pay.
contract RecordingDispatch {
    bytes32[] public paid;

    fallback() external {
        bytes32 to;
        assembly {
            to := calldataload(2)
        }
        paid.push(to);
    }

    function count() external view returns (uint256) {
        return paid.length;
    }
}

/// @notice Upgrading a live pool (implementation at 06af8d0) to the FIFO / park implementation,
///         the way the TC does it: `upgradeToAndCall(impl, 0x)`, no initializer.
contract BasejumpLandingUpgradeTest is Test {
    address constant DISPATCH_PRECOMPILE = 0x0000000000000000000000000000000000000401;
    uint256 constant POOL_AMOUNT = 100_000e6;

    BasejumpLandingV1 v1;
    MockERC20 usdc;
    MockERC20 sourceUsdc;
    address proxy;
    address bridge = makeAddr("bridge");
    bytes32 alice = bytes32(uint256(0xA11CE));
    bytes32 bob = bytes32(uint256(0xB0B));
    bytes32 carol = bytes32(uint256(0xCA401));

    function setUp() public {
        usdc = new MockERC20();
        sourceUsdc = new MockERC20();
        proxy = address(new ERC1967Proxy(address(new BasejumpLandingV1()), abi.encodeCall(BasejumpLandingV1.initialize, ())));
        v1 = BasejumpLandingV1(proxy);
        v1.setAuthorizedBridge(bridge, true);
        v1.setDestAsset(address(sourceUsdc), address(usdc));
        usdc.mint(proxy, POOL_AMOUNT);
        vm.mockCall(DISPATCH_PRECOMPILE, bytes(""), bytes(""));

        // Two payouts queue under the old code (each larger than the pool).
        vm.startPrank(bridge);
        v1.transfer(address(sourceUsdc), POOL_AMOUNT + 1e6, alice, "");
        v1.transfer(address(sourceUsdc), POOL_AMOUNT + 2e6, bob, "");
        vm.stopPrank();
    }

    function _upgrade() internal returns (BasejumpLanding landing) {
        BasejumpLanding impl = new BasejumpLanding();
        BasejumpLanding(proxy).upgradeToAndCall(address(impl), "");
        landing = BasejumpLanding(proxy);
    }

    function testUpgradePreservesQueuedEntriesAndState() public {
        bytes32[6] memory before;
        for (uint256 i = 0; i < 6; i++) {
            before[i] = vm.load(proxy, bytes32(i));
        }

        BasejumpLanding landing = _upgrade();

        for (uint256 i = 0; i < 6; i++) {
            assertEq(vm.load(proxy, bytes32(i)), before[i], "slots 0-5 must not move");
        }
        assertEq(landing.owner(), address(this));
        assertTrue(landing.authorizedBridges(bridge));
        assertEq(landing.destAssetFor(address(sourceUsdc)), address(usdc));
        assertEq(landing.pendingHead(), 0);
        assertEq(landing.pendingTail(), 2);
        (address s0, uint256 a0, bytes32 r0) = landing.pendingTransfers(0);
        (address s1, uint256 a1, bytes32 r1) = landing.pendingTransfers(1);
        assertEq(s0, address(sourceUsdc));
        assertEq(a0, POOL_AMOUNT + 1e6);
        assertEq(r0, alice);
        assertEq(s1, address(sourceUsdc));
        assertEq(a1, POOL_AMOUNT + 2e6);
        assertEq(r1, bob);
        // Pre-upgrade entries reserved nothing.
        assertEq(landing.reservedFor(address(usdc)), 0);
        assertEq(landing.reservedAssetOf(0), address(0));
        assertEq(usdc.balanceOf(proxy), POOL_AMOUNT);

        // They drain in their original order under the new code.
        usdc.mint(proxy, 2 * POOL_AMOUNT + 3e6);
        vm.expectEmit(true, true, true, true);
        emit IBasejumpLanding.PendingTransferFulfilled(0, address(sourceUsdc), address(usdc), alice, POOL_AMOUNT + 1e6);
        landing.fulfillPending();
        vm.expectEmit(true, true, true, true);
        emit IBasejumpLanding.PendingTransferFulfilled(1, address(sourceUsdc), address(usdc), bob, POOL_AMOUNT + 2e6);
        landing.fulfillPending();
        assertEq(landing.pendingHead(), 2);
        assertEq(landing.reservedFor(address(usdc)), 0);
    }

    /// @notice A pre-upgrade head reserved nothing, so while one waits every new payout queues
    ///         behind it, even one the pool could cover.
    function testLegacyHeadKeepsStrictOrderAfterUpgrade() public {
        BasejumpLanding landing = _upgrade();

        // The pool now holds the legacy head's amount, and a little more.
        usdc.mint(proxy, 1e6 + 500e6);

        vm.mockCallRevert(DISPATCH_PRECOMPILE, abi.encodePacked(uint8(79), uint8(0), carol), bytes("newcomer paid first"));
        vm.prank(bridge);
        landing.transfer(address(sourceUsdc), 500e6, carol, "");
        assertEq(landing.pendingTail(), 3, "newcomer must queue behind the legacy head");
        assertEq(landing.reservedFor(address(usdc)), 500e6);
        assertEq(landing.reservedAssetOf(2), address(usdc));

        vm.clearMockedCalls();
        vm.mockCall(DISPATCH_PRECOMPILE, bytes(""), bytes(""));
        landing.fulfillPending(); // alice, legacy
        assertEq(landing.reservedFor(address(usdc)), 500e6, "a legacy fulfil releases nothing");

        // Once the legacy entries are gone, the reservation rule applies on its own.
        usdc.mint(proxy, 2 * POOL_AMOUNT);
        landing.fulfillPending(); // bob, legacy
        landing.fulfillPending(); // carol, reserved
        assertEq(landing.reservedFor(address(usdc)), 0);
        vm.prank(bridge);
        landing.transfer(address(sourceUsdc), 1_000e6, carol, "");
        assertEq(landing.pendingTail(), 3, "empty queue pays directly");
    }

    /// @notice Legacy and new entries across two assets, with a parked legacy head: every newcomer
    ///         queues while ANY legacy entry is at the head (not only the first newcomer), and
    ///         payment order equals id order. (Adopted from the review of #38.)
    function testLegacyMixedOrderAcrossAssetsAndPark() public {
        MockERC20 u = new MockERC20();
        MockERC20 su = new MockERC20();
        MockERC20 e = new MockERC20();
        MockERC20 se = new MockERC20();
        address p = address(new ERC1967Proxy(address(new BasejumpLandingV1()), abi.encodeCall(BasejumpLandingV1.initialize, ())));
        BasejumpLandingV1 old = BasejumpLandingV1(p);
        old.setAuthorizedBridge(bridge, true);
        old.setDestAsset(address(su), address(u));
        old.setDestAsset(address(se), address(e));
        bytes32 dave = bytes32(uint256(0xDA7E));
        vm.startPrank(bridge);
        old.transfer(address(su), 1, dave, ""); // id 0 legacy USDC dust (refused later)
        old.transfer(address(su), 300e6, alice, ""); // id 1 legacy USDC
        old.transfer(address(se), 200e6, bob, ""); // id 2 legacy EURC
        vm.stopPrank();
        BasejumpLanding(p).upgradeToAndCall(address(new BasejumpLanding()), "");
        BasejumpLanding l = BasejumpLanding(p);

        u.mint(p, 10_000e6);
        e.mint(p, 10_000e6);
        vm.clearMockedCalls();
        vm.etch(DISPATCH_PRECOMPILE, address(new RecordingDispatch()).code);
        RecordingDispatch rec = RecordingDispatch(DISPATCH_PRECOMPILE);

        // Two newcomers while a legacy entry is at the head: both queue although the pool could pay.
        vm.startPrank(bridge);
        l.transfer(address(se), 100e6, carol, ""); // id 3
        l.transfer(address(su), 100e6, carol, ""); // id 4
        vm.stopPrank();
        assertEq(l.pendingTail(), 5, "newcomers queue behind legacy");
        assertEq(rec.count(), 0);

        // The legacy dust head is refused by the runtime and parked.
        vm.etch(DISPATCH_PRECOMPILE, hex"");
        vm.mockCallRevert(DISPATCH_PRECOMPILE, abi.encodePacked(uint8(79), uint8(0), dave), bytes("ExistentialDeposit"));
        l.parkPending();
        assertEq(l.pendingHead(), 1);
        vm.clearMockedCalls();
        vm.etch(DISPATCH_PRECOMPILE, address(new RecordingDispatch()).code);

        // Legacy id 1 is now at the head: a payable newcomer must still queue.
        vm.prank(bridge);
        l.transfer(address(se), 1e6, dave, ""); // id 5
        assertEq(l.pendingTail(), 6, "strict while legacy id 1 is at the head");

        for (uint256 i = 0; i < 5; i++) {
            l.fulfillPending();
        }
        assertEq(rec.count(), 5);
        assertEq(rec.paid(0), alice);
        assertEq(rec.paid(1), bob);
        assertEq(rec.paid(2), carol);
        assertEq(rec.paid(3), carol);
        assertEq(rec.paid(4), dave);
        assertEq(l.reservedFor(address(u)), 0);
        assertEq(l.reservedFor(address(e)), 0);
    }
}
