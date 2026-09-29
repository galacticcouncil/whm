// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {HollarBaseVault} from "../../../src/psm/HollarBaseVault.sol";
import {IHollarBaseVault} from "../../../src/psm/interfaces/IHollarBaseVault.sol";
import {PsmPayload} from "../../../src/psm/lib/PsmPayload.sol";
import {RateLimiter} from "../../../src/psm/lib/RateLimiter.sol";
import {
    MockAToken,
    MockAaveOracle,
    MockAavePool,
    MockAddressesProvider,
    MockAggregator,
    MockCappedAdapter,
    MockToken,
    MockWormholeCore
} from "../mocks/PsmMocks.sol";

/// @title Review edge case — admin cancel path after an unpayable retirement.
/// @notice `_cancel` hard-sets `queueHead = index + 1` without its own head check; the head
///         invariant rests entirely on the external guards. This verifies the guard ordering
///         holds: a retired head leaves the next live entry AS the head, so the admin path cannot
///         reach a non-head slot.
contract CancelAfterUnpayableTest is Test, IHollarBaseVault {
    HollarBaseVault internal vault;
    MockToken internal usdc;
    MockAToken internal aUsdc;
    MockAavePool internal pool;
    MockWormholeCore internal wormhole;

    uint16 internal constant BASE_CHAIN = 30;
    uint16 internal constant HYDRATION_CHAIN = 73;
    bytes32 internal constant HYDRATION_EMITTER = bytes32(uint256(0x4bd7a));

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal treasurer = makeAddr("treasurer");
    address internal alice = makeAddr("alice");
    address internal mallory = makeAddr("mallory");

    function setUp() public {
        vm.warp(365 days);
        wormhole = new MockWormholeCore(BASE_CHAIN, 0);
        usdc = new MockToken("USDC", 6);
        aUsdc = new MockAToken();
        pool = new MockAavePool(usdc, aUsdc);
        MockAggregator aggregator = new MockAggregator(1e8);
        MockCappedAdapter cappedAdapter = new MockCappedAdapter(aggregator);
        MockAddressesProvider provider = new MockAddressesProvider(
            address(pool), address(new MockAaveOracle(address(cappedAdapter), aggregator))
        );

        HollarBaseVault impl = new HollarBaseVault();
        vault = HollarBaseVault(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        HollarBaseVault.initializeVault,
                        (
                            VaultInit({
                                wormhole: address(wormhole),
                                usdc: address(usdc),
                                aUsdc: address(aUsdc),
                                addressesProvider: address(provider),
                                hydrationChainId: HYDRATION_CHAIN,
                                minUsdcPrice: 99e6,
                                admin: admin,
                                guardian: guardian,
                                treasurer: treasurer
                            })
                        )
                    )
                )
            )
        );

        vm.startPrank(admin);
        vault.setHydrationEmitter(HYDRATION_EMITTER);
        vault.setDepositLimit(RateLimiter.UNLIMITED, 0);
        vm.stopPrank();
        vm.prank(guardian);
        vault.setDepositsPaused(false);

        usdc.mint(alice, 1_000_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _redeemVaaSalted(address recipient, uint256 amount, uint256 salt) internal view returns (bytes memory) {
        return abi.encode(
            HYDRATION_CHAIN,
            HYDRATION_EMITTER,
            PsmPayload.encode(PsmPayload.KIND_REDEEM, PsmPayload.fromAddress(recipient), amount, PsmPayload.fromAddress(recipient)),
            salt
        );
    }

    function test_adminCancel_afterUnpayableRetirement_onlyReachesTheLiveHead() public {
        vm.prank(alice);
        vault.deposit(200_000e6, PsmPayload.fromAddress(alice));

        uint256 gross0 = 100_000e6;
        uint256 net0 = gross0 - (gross0 * vault.redeemFeeBps()) / 10_000;

        // Slot 0 = mallory (will be unpayable), slot 1 = alice.
        vault.receiveMessage(_redeemVaaSalted(mallory, gross0, 1));
        vault.receiveMessage(_redeemVaaSalted(alice, 50_000e6, 2));

        vm.mockCallRevert(
            address(usdc), abi.encodeWithSignature("transfer(address,uint256)", mallory, net0), "BLACKLISTED"
        );
        vault.drain(1);
        vm.clearMockedCalls();

        assertEq(vault.queueHead(), 1, "head advanced past the retired slot");
        assertEq(vault.unpayable(mallory), net0, "retired into unpayable");
        (, , uint256 slot0Amount,) = vault.queue(0);
        assertEq(slot0Amount, 0, "slot 0 zeroed");

        // Alice is now the live head. Admin-cancel works on her — as designed, head-only.
        vm.prank(admin);
        vault.cancelQueuedRedemptionFor(1);
        assertEq(vault.queueHead(), 2);

        // A retired slot reverts on the amount check before the head check.
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(NotQueued.selector, 0));
        vault.cancelQueuedRedemptionFor(0);
    }
}
