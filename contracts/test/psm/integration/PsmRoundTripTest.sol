// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {HollarBaseFacilitator} from "../../../src/psm/HollarBaseFacilitator.sol";
import {HollarBaseVault} from "../../../src/psm/HollarBaseVault.sol";
import {IHollarBaseVault} from "../../../src/psm/interfaces/IHollarBaseVault.sol";
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
    MockWormholeCore
} from "../mocks/PsmMocks.sol";

/// @title Both ends of the corridor, wired together
/// @notice The unit suites test each side against a hand-built payload. This one lets the two
///         contracts talk: whatever the vault publishes is what the facilitator decodes, and back.
///         A disagreement about the wire shows up here and nowhere else.
///
/// @dev The invariant under test throughout is the cross-chain one: principal × 1e12 >= bucket
///      level, with equality at rest. A persistent gap is a lost message; a violation is unbacked
///      HOLLAR.
/// @dev Deliberately inherits neither interface: the two declare overlapping error names, which
///      is fine on chain and a compile error in one test contract. Types are qualified instead.
contract PsmRoundTripTest is Test {
    HollarBaseVault internal vault;
    HollarBaseFacilitator internal facilitator;

    MockToken internal usdc;
    MockAToken internal aUsdc;
    MockAavePool internal pool;
    MockAggregator internal aggregator;
    MockGho internal hollar;
    MockWormholeCore internal baseCore;
    MockWormholeCore internal hydrationCore;

    uint16 internal constant BASE_CHAIN = 30;
    uint16 internal constant HYDRATION_CHAIN = 73;
    uint256 internal constant SCALE = 1e12;
    uint256 internal constant CAPACITY = 10_000e18;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal treasurer = makeAddr("treasurer");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        vm.warp(365 days);

        usdc = new MockToken("USDC", 6);
        aUsdc = new MockAToken();
        pool = new MockAavePool(usdc, aUsdc);
        aggregator = new MockAggregator(1e8);
        hollar = new MockGho();

        baseCore = new MockWormholeCore(BASE_CHAIN, 0);
        hydrationCore = new MockWormholeCore(HYDRATION_CHAIN, 0);

        MockAddressesProvider provider = new MockAddressesProvider(
            address(pool), address(new MockAaveOracle(address(new MockCappedAdapter(aggregator)), aggregator))
        );

        vault = HollarBaseVault(
            address(
                new ERC1967Proxy(
                    address(new HollarBaseVault()),
                    abi.encodeCall(
                        HollarBaseVault.initializeVault,
                        (
                            IHollarBaseVault.VaultInit({
                                wormhole: address(baseCore),
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

        facilitator = HollarBaseFacilitator(
            address(
                new ERC1967Proxy(
                    address(new HollarBaseFacilitator()),
                    abi.encodeCall(
                        HollarBaseFacilitator.initializeFacilitator,
                        (address(hydrationCore), address(hollar), 6, BASE_CHAIN, admin, guardian)
                    )
                )
            )
        );

        hollar.addFacilitator(address(facilitator), CAPACITY);

        vm.startPrank(admin);
        vault.setHydrationEmitter(_toBytes32(address(facilitator)));
        vault.setDepositLimit(RateLimiter.UNLIMITED, 0);
        facilitator.setBaseEmitter(_toBytes32(address(vault)));
        facilitator.setLimits(RateLimiter.UNLIMITED, RateLimiter.UNLIMITED, 0);
        vm.stopPrank();

        vm.startPrank(guardian);
        vault.setDepositsPaused(false);
        facilitator.setPaused(false, false);
        vm.stopPrank();

        usdc.mint(alice, 1_000_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ─── The relay ──────────────────────────────────────────────

    function _toBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    /// @dev Stands in for the relayer bot: take the last message a chain published and hand it to
    ///      the other side. Deliberately dumb — it does not inspect or reshape the payload, so any
    ///      encode/decode mismatch between the two contracts surfaces as a failure here.
    /// @dev Stands in for the Wormhole sequence, which is part of a real VAA's hash. Without it two
    ///      genuinely distinct messages carrying the same payload -- a deposit and the mint from a
    ///      later cancellation, say -- would collide and the second would look like a replay.
    uint256 internal relaySequence;

    function _relayBaseToHydration() internal {
        bytes memory payload = baseCore.lastPublished().payload;
        facilitator.receiveMessage(abi.encode(BASE_CHAIN, _toBytes32(address(vault)), payload, ++relaySequence));
    }

    function _relayHydrationToBase() internal {
        bytes memory payload = hydrationCore.lastPublished().payload;
        vault.receiveMessage(
            abi.encode(HYDRATION_CHAIN, _toBytes32(address(facilitator)), payload, ++relaySequence)
        );
    }

    // ─── Invariants ─────────────────────────────────────────────

    function _bucketLevel() internal view returns (uint256 level) {
        (, level) = hollar.getFacilitatorBucket(address(facilitator));
    }

    /// @dev principal × 1e12 >= bucket level + pending × 1e12: every attested unit is minted,
    ///      queued, or in flight. A violation is HOLLAR, or a pending claim, nobody locked USDC for.
    function _assertBacked() internal view {
        assertGe(
            vault.principal() * SCALE,
            _bucketLevel() + facilitator.totalPendingMint() * SCALE,
            "unbacked HOLLAR"
        );
    }

    function _assertSolvent() internal view {
        uint256 assets = usdc.balanceOf(address(vault)) + aUsdc.balanceOf(address(vault));
        assertGe(assets, vault.principal() + vault.totalOwed() + vault.totalUnpayable(), "vault insolvent");
    }

    // ─── Full round trip ────────────────────────────────────────

    function test_roundTrip_depositMintRedeemClaim() public {
        // 1 — lock on Base
        vm.prank(alice);
        vault.deposit(1_000e6, _toBytes32(alice));
        assertEq(vault.principal(), 1_000e6);
        _assertBacked();

        // 2 — mint on Hydration
        _relayBaseToHydration();
        assertEq(hollar.balanceOf(alice), 1_000e18, "1000 USDC becomes 1000 HOLLAR");
        assertEq(vault.principal() * SCALE, _bucketLevel(), "equal at rest");
        _assertBacked();

        // 3 — burn on Hydration
        vm.startPrank(alice);
        hollar.approve(address(facilitator), type(uint256).max);
        facilitator.redeem(1_000e6, bob, type(uint16).max);
        vm.stopPrank();
        assertEq(_bucketLevel(), 0, "the burn released the whole bucket");

        // 4 — credit on Base
        _relayHydrationToBase();
        uint256 fee = (1_000e6 * 5) / 10_000;
        assertEq(vault.owed(bob), 1_000e6 - fee);
        assertEq(vault.principal(), 0);
        _assertBacked();
        _assertSolvent();

        // 5 — take payment
        vm.prank(bob);
        vault.claim();

        assertEq(usdc.balanceOf(bob), 1_000e6 - fee);
        assertEq(vault.totalOwed(), 0);
        assertEq(vault.surplus(), fee, "the fee is all that stayed behind");
        _assertSolvent();
    }

    /// @dev The wire is the one thing both sides must agree on byte for byte. A relay that never
    ///      inspects the payload is the only way to catch a one-sided change to it.
    function testFuzz_roundTrip_anyAmount(uint64 raw) public {
        uint256 amount = bound(raw, 10e6, 10_000e6);

        vm.prank(alice);
        vault.deposit(amount, _toBytes32(alice));
        _relayBaseToHydration();

        assertEq(hollar.balanceOf(alice), amount * SCALE);
        assertEq(vault.principal() * SCALE, _bucketLevel());
        _assertBacked();
    }

    // ─── Cancelled mint ─────────────────────────────────────────

    /// @dev Deposit, mint queues because the bucket is too small, holder gives up, USDC comes back
    ///      on Base with no fee. The path that closes "queued forever".
    function test_roundTrip_queuedMintCancelledAndRefunded() public {
        hollar.setFacilitatorBucketCapacity(address(facilitator), 100e18);

        vm.prank(alice);
        vault.deposit(500e6, _toBytes32(alice));
        _relayBaseToHydration();

        assertEq(facilitator.pendingOf(alice), 500e6, "queued, not minted");
        assertEq(hollar.balanceOf(alice), 0);
        _assertBacked();

        vm.prank(alice);
        facilitator.cancelPendingMint(0, type(uint16).max);
        _relayHydrationToBase();

        assertEq(vault.owed(alice), 500e6, "a refund carries no fee");
        assertEq(vault.principal(), 0);
        assertEq(_bucketLevel(), 0, "nothing was ever minted");

        vm.prank(alice);
        vault.claim();
        assertEq(usdc.balanceOf(alice), 1_000_000e6, "made whole, to the unit");
        _assertSolvent();
    }

    // ─── Partial redemption under thin liquidity ────────────────

    /// @dev The burn is irreversible and happens first; the vault may not have the liquidity yet.
    ///      The queue is what makes that survivable, so the credit must outlive the shortfall.
    function test_roundTrip_burnSurvivesEmptyReserve() public {
        vm.prank(alice);
        vault.deposit(10_000e6, _toBytes32(alice));
        _relayBaseToHydration();

        vm.startPrank(alice);
        hollar.approve(address(facilitator), type(uint256).max);
        facilitator.redeem(10_000e6, alice, type(uint16).max);
        vm.stopPrank();

        // Borrowers drain the reserve before the credit lands.
        aUsdc.release(address(usdc), address(0xB0B0), 9_500e6);

        _relayHydrationToBase();
        uint256 credited = 10_000e6 - 5e6;
        assertEq(vault.owed(alice), credited, "credited in full despite no liquidity");

        // Whole-fill: the reserve cannot cover the credit, so it pays nothing and waits.
        assertEq(vault.drain(5), 0, "no partial fill");
        assertEq(vault.owed(alice), credited, "the credit is intact");
        (address head,) = vault.queueHeadEntry();
        assertEq(head, alice, "still at the head");

        // Liquidity returns; the claim completes in one go.
        usdc.mint(address(aUsdc), 20_000e6);
        assertEq(vault.drain(5), credited, "paid whole");
        assertEq(vault.owed(alice), 0);
        assertEq(vault.totalOwed(), 0);
        _assertBacked();
        _assertSolvent();
    }

    // ─── Cancelling a stalled redemption ────────────────────────

    /// @dev The burn on Hydration is irreversible, so a redeemer stuck behind a stalled head needs
    ///      a way back to their HOLLAR. Cancelling re-mints the gross and restores the backing, so
    ///      the corridor lands exactly where it stood before the redemption.
    function test_roundTrip_stalledRedemptionCancelledAndReminted() public {
        vm.prank(alice);
        vault.deposit(10_000e6, _toBytes32(alice));
        _relayBaseToHydration();

        uint256 bucketAfterMint = _bucketLevel();
        uint256 principalAfterMint = vault.principal();

        vm.startPrank(alice);
        hollar.approve(address(facilitator), type(uint256).max);
        facilitator.redeem(10_000e6, alice, type(uint16).max);
        vm.stopPrank();

        assertEq(hollar.balanceOf(alice), 0, "HOLLAR burned, irreversibly");

        // Borrowers take the reserve; the credit lands and cannot be filled.
        aUsdc.release(address(usdc), address(0xB0B0), 9_500e6);
        _relayHydrationToBase();
        assertEq(vault.drain(5), 0, "stalled");

        // Alice walks away from the queue.
        (bool found, uint256 index,) = vault.queueEntryOf(alice);
        assertTrue(found);
        vm.prank(alice);
        vault.cancelQueuedRedemption(index);

        assertEq(vault.owed(alice), 0, "no longer queued");
        assertEq(vault.principal(), principalAfterMint, "backing restored exactly");

        // The cancellation rides back as a mint and reissues what she burned.
        _relayBaseToHydration();
        assertEq(hollar.balanceOf(alice), 10_000e18, "gross re-minted, no fee charged");
        assertEq(_bucketLevel(), bucketAfterMint, "bucket back where it started");

        _assertBacked();
        _assertSolvent();
    }

    // ─── Cancelling a queued re-mint ────────────────────────────

    /// @dev The cycle that used to be a free redemption: redeem (fee assessed on Base), cancel at
    ///      the head (gross re-minted), the re-mint queues on the inbound limit — which it does by
    ///      default on the day of the original mint — and is cancelled in turn. That second cancel
    ///      goes back as a redemption, so the credit it produces is field-for-field the one the
    ///      first cancel undid, and the fee is paid exactly once.
    function test_roundTrip_cancelledRemintPaysTheRedeemFee() public {
        vm.prank(admin);
        facilitator.setLimits(10_000e6, RateLimiter.UNLIMITED, 1 days);

        vm.prank(alice);
        vault.deposit(10_000e6, _toBytes32(alice));
        _relayBaseToHydration(); // spends the day's inbound window

        // Alice burns, naming bob on Base — so recipient and origin differ all the way round.
        vm.startPrank(alice);
        hollar.approve(address(facilitator), type(uint256).max);
        facilitator.redeem(10_000e6, bob, type(uint16).max);
        vm.stopPrank();
        _relayHydrationToBase();

        uint256 fee = (10_000e6 * 5) / 10_000;
        assertEq(vault.owed(bob), 10_000e6 - fee);

        // 1 — bob walks away from the head: the gross is re-minted to alice...
        vm.prank(bob);
        vault.cancelQueuedRedemption(0);
        _relayBaseToHydration();
        assertEq(facilitator.pendingOf(alice), 10_000e6, "...and queues on the spent inbound window");
        assertEq(hollar.balanceOf(alice), 0);

        // 2 — alice cancels the queued re-mint: back to Base as a redemption, not a refund.
        vm.prank(alice);
        facilitator.cancelPendingMint(0, type(uint16).max);
        _relayHydrationToBase();

        (address recipient, address origin,, uint256 amount, uint256 gross) = vault.queue(1);
        assertEq(recipient, bob, "the credit the cancel undid: same Base recipient");
        assertEq(origin, alice, "same Hydration redeemer");
        assertEq(amount, 10_000e6 - fee, "fee included");
        assertEq(gross, 10_000e6);

        vm.prank(bob);
        vault.claim();
        assertEq(usdc.balanceOf(bob), 10_000e6 - fee, "one fee, however the queue was walked");
        assertEq(vault.surplus(), fee);
        _assertBacked();
        _assertSolvent();
    }

    /// @dev Walking that loop again changes nothing: the credit comes back identical every time,
    ///      and the fee is still paid once at the end.
    function test_roundTrip_cancelLoopIsAFixedPoint() public {
        vm.prank(admin);
        facilitator.setLimits(10_000e6, RateLimiter.UNLIMITED, 1 days);

        vm.prank(alice);
        vault.deposit(10_000e6, _toBytes32(alice));
        _relayBaseToHydration();
        vm.startPrank(alice);
        hollar.approve(address(facilitator), type(uint256).max);
        facilitator.redeem(10_000e6, alice, type(uint16).max);
        vm.stopPrank();
        _relayHydrationToBase();

        uint256 fee = (10_000e6 * 5) / 10_000;
        for (uint256 i = 0; i < 3; i++) {
            uint256 head = vault.queueHead();
            vm.prank(alice);
            vault.cancelQueuedRedemption(head);
            assertEq(vault.principal() + vault.totalOwed(), 10_000e6, "gross back in principal");
            _relayBaseToHydration();

            (bool found, uint256 id) = facilitator.pendingEntryOf(alice, 0, 10);
            assertTrue(found, "the re-mint queued");
            vm.prank(alice);
            facilitator.cancelPendingMint(id, type(uint16).max);
            _relayHydrationToBase();

            (,,, uint256 amount, uint256 gross) = vault.queue(vault.queueHead());
            assertEq(amount, 10_000e6 - fee, "the same credit every time");
            assertEq(gross, 10_000e6);
            assertEq(vault.principal() + vault.totalOwed(), 10_000e6, "the books conserve the gross");
            assertEq(hollar.balanceOf(alice), 0, "nothing mints along the way");
        }

        vm.prank(alice);
        vault.claim();
        assertEq(usdc.balanceOf(alice), 1_000_000e6 - fee);
        _assertSolvent();
    }

    // ─── Replay across the corridor ─────────────────────────────

    function test_roundTrip_replayIsRefusedOnBothSides() public {
        vm.prank(alice);
        vault.deposit(1_000e6, _toBytes32(alice));

        bytes memory mintVaa =
            abi.encode(BASE_CHAIN, _toBytes32(address(vault)), baseCore.lastPublished().payload);
        facilitator.receiveMessage(mintVaa);

        vm.expectRevert("VAA already processed");
        facilitator.receiveMessage(mintVaa);

        assertEq(_bucketLevel(), 1_000e18, "one deposit, one mint");
        _assertBacked();
    }

    // ─── Fee raised in flight ───────────────────────────────────

    /// @dev The fee is assessed when the credit lands. A raise inside the relay window used to
    ///      re-price a burn that could not be undone; now the burn carries the limit it was quoted,
    ///      and above it the HOLLAR comes back whole.
    function test_roundTrip_feeRaisedInFlightReturnsTheHollar() public {
        vm.prank(alice);
        vault.deposit(10_000e6, _toBytes32(alice));
        _relayBaseToHydration();

        vm.startPrank(alice);
        hollar.approve(address(facilitator), type(uint256).max);
        facilitator.redeem(10_000e6, bob, 5); // quoted 5 bps
        vm.stopPrank();
        assertEq(hollar.balanceOf(alice), 0);

        vm.prank(admin);
        vault.setFees(50, 25); // raised before the message lands

        _relayHydrationToBase();
        assertEq(vault.owed(bob), 0, "not booked at a fee she never agreed to");
        assertEq(vault.principal(), 10_000e6, "backing untouched");

        _relayBaseToHydration();
        assertEq(hollar.balanceOf(alice), 10_000e18, "the burn came back whole");
        assertEq(vault.principal() * SCALE, _bucketLevel(), "equal at rest");
        _assertBacked();
        _assertSolvent();
    }

    // ─── A cancelled refund ─────────────────────────────────────

    /// @dev A deposit that never minted owes no redemption fee, however often it is cancelled.
    ///      Its refund credit, cancelled at the vault head by the depositor it is addressed to,
    ///      goes back as the mint it was; cancelled again on Hydration it refunds in full.
    function test_roundTrip_cancelledRefundStaysFeeFree() public {
        hollar.setFacilitatorBucketCapacity(address(facilitator), 100e18); // 500 cannot mint

        vm.prank(alice);
        vault.deposit(500e6, _toBytes32(bob));
        _relayBaseToHydration();
        assertEq(facilitator.pendingOf(bob), 500e6, "queued");

        vm.prank(bob);
        facilitator.cancelPendingMint(0, type(uint16).max);
        _relayHydrationToBase();
        assertEq(vault.owed(alice), 500e6, "refunded in full");

        vm.prank(alice); // the depositor wants the mint after all
        vault.cancelQueuedRedemption(0);
        _relayBaseToHydration();
        assertEq(facilitator.pendingOf(bob), 500e6, "back in the mint queue, as a mint");

        vm.prank(bob);
        facilitator.cancelPendingMint(1, type(uint16).max);
        _relayHydrationToBase();

        assertEq(vault.owed(alice), 500e6, "still in full: nothing was ever redeemed");
        assertEq(vault.surplus(), 0, "no fee taken");
        _assertBacked();
        _assertSolvent();
    }

    // ─── Cancel or pay, never both ──────────────────────────────

    /// @dev One credit has one way out. Cancel and payment both act on the same queue slot on
    ///      Base, so whichever lands first consumes it and the other finds nothing. The HOLLAR
    ///      comes back only through the message the cancel itself publishes — there is nothing a
    ///      redeemer can trigger on Hydration to be made whole twice.
    function test_roundTrip_cancelAndPaymentAreMutuallyExclusive() public {
        vm.prank(alice);
        vault.deposit(2_000e6, _toBytes32(alice));
        _relayBaseToHydration();
        uint256 usdcAfterDeposit = usdc.balanceOf(alice);

        vm.startPrank(alice);
        hollar.approve(address(facilitator), type(uint256).max);
        facilitator.redeem(1_000e6, alice, type(uint16).max);
        vm.stopPrank();
        _relayHydrationToBase(); // credit 0

        // Cancel lands first: the payment paths then find nothing.
        vm.prank(alice);
        vault.cancelQueuedRedemption(0);
        assertEq(vault.drain(10), 0, "nothing left to pay");
        vm.prank(alice);
        vm.expectRevert();
        vault.claim();
        assertEq(usdc.balanceOf(alice), usdcAfterDeposit, "no USDC moved");

        _relayBaseToHydration();
        assertEq(hollar.balanceOf(alice), 2_000e18, "HOLLAR back, once");

        // Payment lands first: the cancel then finds nothing, and nothing is re-minted.
        vm.prank(alice);
        facilitator.redeem(1_000e6, alice, type(uint16).max);
        _relayHydrationToBase(); // credit 1
        uint256 fee = (1_000e6 * 5) / 10_000;
        assertEq(vault.drain(10), 1_000e6 - fee, "paid");

        uint256 published = baseCore.publishedCount();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IHollarBaseVault.NotQueued.selector, 1));
        vault.cancelQueuedRedemption(1);
        assertEq(baseCore.publishedCount(), published, "no re-mint went out");

        assertEq(usdc.balanceOf(alice), usdcAfterDeposit + 1_000e6 - fee, "paid once");
        assertEq(hollar.balanceOf(alice), 1_000e18, "and that HOLLAR stays burned");
        _assertBacked();
        _assertSolvent();
    }
}
