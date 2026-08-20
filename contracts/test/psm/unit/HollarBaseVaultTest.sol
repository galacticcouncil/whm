// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {MessageReceiver} from "../../../src/MessageReceiver.sol";
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
    MockWormholeCore,
    VaaBuilder
} from "../mocks/PsmMocks.sol";

/// @title HollarBaseVault — Base leg
/// @notice The side that holds the money. The properties under test are the ones that decide
///         whether a redeemer is paid in the order they arrived and whether the reserve can be
///         swept out from under them.
contract HollarBaseVaultTest is Test, IHollarBaseVault {
    HollarBaseVault internal vault;
    MockToken internal usdc;
    MockAToken internal aUsdc;
    MockAavePool internal pool;
    MockAddressesProvider internal provider;
    MockAggregator internal aggregator;
    MockCappedAdapter internal cappedAdapter;
    MockWormholeCore internal wormhole;

    uint16 internal constant BASE_CHAIN = 30;
    uint16 internal constant HYDRATION_CHAIN = 73;
    bytes32 internal constant HYDRATION_EMITTER = bytes32(uint256(0x4bd7a));

    /// @dev AaveOracle's USD base is 8 dp. One dollar is 1e8.
    uint256 internal constant ONE_USD = 1e8;
    uint256 internal constant MIN_PRICE = 99e6; // $0.99

    /// @dev 26 h. The Base USDC/USD feed's heartbeat is 24 h to the second, so the spec's 1 h
    ///      default would refuse deposits for 23 of every 24 hours.

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal treasurer = makeAddr("treasurer");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        vm.warp(365 days);

        wormhole = new MockWormholeCore(BASE_CHAIN, 0);
        usdc = new MockToken("USDC", 6);
        aUsdc = new MockAToken();
        pool = new MockAavePool(usdc, aUsdc);
        aggregator = new MockAggregator(int256(ONE_USD));
        cappedAdapter = new MockCappedAdapter(aggregator);
        provider = new MockAddressesProvider(
            address(pool), address(new MockAaveOracle(address(cappedAdapter), aggregator))
        );

        HollarBaseVault implementation = new HollarBaseVault();
        vault = HollarBaseVault(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(
                        HollarBaseVault.initializeVault,
                        (
                            VaultInit({
                                wormhole: address(wormhole),
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

        vm.startPrank(admin);
        vault.setHydrationEmitter(HYDRATION_EMITTER);
        vault.setDepositLimit(RateLimiter.UNLIMITED, 0);
        vm.stopPrank();

        vm.prank(guardian);
        vault.setDepositsPaused(false);

        usdc.mint(alice, 1_000_000e6);
        usdc.mint(bob, 1_000_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ─── Helpers ────────────────────────────────────────────────

    function _redeemVaa(address recipient, uint256 amount, uint8 kind) internal pure returns (bytes memory) {
        return VaaBuilder.build(
            HYDRATION_CHAIN, HYDRATION_EMITTER, PsmPayload.encode(kind, PsmPayload.fromAddress(recipient), amount)
        );
    }

    /// @dev Salted so two credits of the same shape are distinct VAAs, as they would be on-chain.
    function _redeemVaaSalted(address recipient, uint256 amount, uint8 kind, uint256 salt)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            HYDRATION_CHAIN, HYDRATION_EMITTER, PsmPayload.encode(kind, PsmPayload.fromAddress(recipient), amount), salt
        );
    }

    function _deposit(address who, uint256 amount) internal {
        vm.prank(who);
        vault.deposit(amount, PsmPayload.fromAddress(who));
    }

    /// @dev Simulates borrowers drawing the reserve down: the aToken keeps its accounting, the
    ///      underlying is simply not there to withdraw.
    function _borrowFromAave(uint256 amount) internal {
        aUsdc.release(address(usdc), address(0xB0B0), amount);
    }

    /// @dev The borrowers pay it back.
    function _repayToAave(uint256 amount) internal {
        vm.prank(address(0xB0B0));
        usdc.transfer(address(aUsdc), amount);
    }

    // ─── Solvency ───────────────────────────────────────────────

    /// @dev The invariant the whole vault exists to hold. Delayed credits are liabilities too —
    ///      leaving them out is how a sweep pays itself with someone else's money.
    function _assertSolvent() internal view {
        uint256 assets = usdc.balanceOf(address(vault)) + aUsdc.balanceOf(address(vault));
        uint256 liabilities = vault.principal() + vault.totalOwed() + vault.totalUnpayable();
        assertGe(assets, liabilities, "assets must cover principal + owed + delayed");
    }

    // ─── Deposit ────────────────────────────────────────────────

    function test_deposit_locksAttestsAndInvests() public {
        _deposit(alice, 500e6);

        assertEq(vault.principal(), 500e6);
        assertEq(aUsdc.balanceOf(address(vault)), 500e6, "supplied to Aave");
        assertEq(usdc.balanceOf(address(vault)), 0, "nothing left idle");

        (uint8 kind, bytes32 recipient, uint256 amount) = PsmPayload.decode(wormhole.lastPublished().payload);
        assertEq(kind, PsmPayload.KIND_MINT);
        assertEq(PsmPayload.toAddress(recipient), alice);
        assertEq(amount, 500e6);
        _assertSolvent();
    }

    /// @dev 200 is the only level this route supports, so size buys no extra certainty. Pinned
    ///      because a silent switch to 201 would publish messages the guardians never sign.
    function test_deposit_alwaysPublishesInstant() public {
        _deposit(alice, 10e6);
        assertEq(wormhole.lastPublished().consistencyLevel, 200, "small");

        _deposit(alice, 500_000e6);
        assertEq(wormhole.lastPublished().consistencyLevel, 200, "large is no different");
    }

    /// @dev Rejected here, where the depositor still holds their money. The far side has no way
    ///      to give it back.
    function test_deposit_rejectsNonH160Recipient() public {
        bytes32 accountId32 = bytes32(uint256(1) << 200);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PsmPayload.NotAnAddress.selector, accountId32));
        vault.deposit(100e6, accountId32);
    }

    function test_deposit_rejectsZeroRecipient() public {
        vm.prank(alice);
        vm.expectRevert(PsmPayload.ZeroRecipient.selector);
        vault.deposit(100e6, bytes32(0));
    }

    function test_deposit_refusesBelowFloorPrice() public {
        aggregator.set(int256(98e6), block.timestamp);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(UsdcBelowFloor.selector, 98e6, MIN_PRICE));
        vault.deposit(100e6, PsmPayload.fromAddress(alice));
    }


    /// @dev A day-old price is normal for this pair, not a fault. Pinned because a threshold
    ///      tighter than the heartbeat looks prudent and silently closes the mint leg.
    function test_deposit_acceptsPriceOlderThanADay() public {
        aggregator.set(int256(ONE_USD), block.timestamp - 24 hours - 5 minutes);

        _deposit(alice, 100e6);
        assertEq(vault.principal(), 100e6);
    }

    /// @dev Aave's named source on Base reverts on latestRoundData. The deposit path must never
    ///      touch it — if it did, every deposit would revert on mainnet.
    function test_deposit_doesNotReadAaveNamedSource() public {
        vm.expectRevert(bytes("unknown selector"));
        cappedAdapter.latestRoundData();

        _deposit(alice, 100e6);
        assertEq(vault.principal(), 100e6, "deposits work despite the source being unreadable");
    }

    function test_deposit_refusesNonPositivePrice() public {
        aggregator.set(0, block.timestamp);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OraclePriceInvalid.selector, int256(0)));
        vault.deposit(100e6, PsmPayload.fromAddress(alice));
    }

    /// @dev The oracle gate shuts the mint leg only. Redemption stays open because that direction
    ///      reduces exposure — tested here as "credits still land".
    function test_redeemLegOpenWhileOracleGateShut() public {
        _deposit(alice, 500e6);
        aggregator.set(int256(50e6), block.timestamp);

        vault.receiveMessage(_redeemVaa(alice, 100e6, PsmPayload.KIND_REDEEM));
        assertGt(vault.owed(alice), 0, "a shut mint gate must not block the exit");
    }

    function test_deposit_respectsRateLimit() public {
        vm.prank(admin);
        vault.setDepositLimit(100e6, 1 days);

        _deposit(alice, 100e6);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RateLimiter.RateLimitExceeded.selector, 100e6, 0));
        vault.deposit(100e6, PsmPayload.fromAddress(alice));
    }


    function test_deposit_respectsPause() public {
        vm.prank(guardian);
        vault.setDepositsPaused(true);

        vm.prank(alice);
        vm.expectRevert(DepositsPaused.selector);
        vault.deposit(100e6, PsmPayload.fromAddress(alice));
    }

    /// @dev Aave refusing must never block a deposit: the USDC is locked and attested either way,
    ///      and yield is a strictly lesser concern than the message going out.
    function test_deposit_survivesAaveRefusing() public {
        pool.setSupplyReverts(true);

        _deposit(alice, 100e6);

        assertEq(vault.principal(), 100e6);
        assertEq(usdc.balanceOf(address(vault)), 100e6, "held here instead of Aave");
        assertEq(wormhole.publishedCount(), 1, "the attestation still went out");
        _assertSolvent();
    }

    // ─── Credit ─────────────────────────────────────────────────

    function test_receiveRedeem_creditsNetOfFee() public {
        _deposit(alice, 1_000e6);

        vault.receiveMessage(_redeemVaa(bob, 100e6, PsmPayload.KIND_REDEEM));

        assertEq(vault.principal(), 900e6, "principal falls by the gross");
        assertEq(vault.owed(bob), 100e6 - 5e4, "the recipient is credited net of 5 bps");
        assertEq(vault.totalOwed(), 100e6, "but the reserve holds the gross until it pays");
        _assertSolvent();
    }

    /// @dev A refund is a cancelled mint coming home. No service was rendered, so no fee.
    function test_receiveRedeem_refundCarriesNoFee() public {
        _deposit(alice, 1_000e6);

        vault.receiveMessage(_redeemVaa(bob, 100e6, PsmPayload.KIND_REFUND));

        assertEq(vault.owed(bob), 100e6, "a refund is made whole");
        _assertSolvent();
    }

    function test_receiveRedeem_neverMovesMoney() public {
        _deposit(alice, 1_000e6);
        uint256 before = usdc.balanceOf(bob);

        vault.receiveMessage(_redeemVaa(bob, 100e6, PsmPayload.KIND_REDEEM));

        assertEq(usdc.balanceOf(bob), before, "crediting is bookkeeping, never a transfer");
    }

    /// @dev More claimed than was ever attested. Consume the VAA once and park it, rather than
    ///      leave a message that reverts forever and can be resubmitted forever.
    function test_receiveRedeem_parksOverClaim() public {
        _deposit(alice, 100e6);

        vault.receiveMessage(_redeemVaa(bob, 500e6, PsmPayload.KIND_REDEEM));

        assertEq(vault.disputed(bob), 500e6);
        assertEq(vault.owed(bob), 0);
        assertEq(vault.principal(), 100e6, "principal untouched by a claim we do not believe");
    }

    function test_receiveRedeem_rejectsWrongKind() public {
        vm.expectRevert(abi.encodeWithSelector(UnexpectedKind.selector, PsmPayload.KIND_MINT));
        vault.receiveMessage(_redeemVaa(bob, 10e6, PsmPayload.KIND_MINT));
    }

    function test_receiveRedeem_rejectsUnauthorizedEmitter() public {
        bytes memory vaa = VaaBuilder.build(
            HYDRATION_CHAIN,
            bytes32(uint256(0xdead)),
            PsmPayload.encode(PsmPayload.KIND_REDEEM, PsmPayload.fromAddress(bob), 10e6)
        );

        vm.expectRevert(MessageReceiver.NotAuthorizedEmitter.selector);
        vault.receiveMessage(vaa);
    }

    function test_receiveRedeem_rejectsReplay() public {
        _deposit(alice, 1_000e6);
        bytes memory vaa = _redeemVaa(bob, 100e6, PsmPayload.KIND_REDEEM);

        vault.receiveMessage(vaa);
        vm.expectRevert("VAA already processed");
        vault.receiveMessage(vaa);
    }

    // ─── Queue ordering ─────────────────────────────────────────

    /// @dev The rule that gets designed away by accident. A drip of small claims must not walk
    ///      past a large head, however comfortably each one fits the liquidity of the moment.
    function test_queue_smallClaimsCannotOvertakeLargeHead() public {
        _deposit(alice, 100_000e6);

        vault.receiveMessage(_redeemVaaSalted(alice, 50_000e6, PsmPayload.KIND_REDEEM, 1));
        vault.receiveMessage(_redeemVaaSalted(bob, 10e6, PsmPayload.KIND_REDEEM, 2));

        // Only enough liquidity for the small one.
        _borrowFromAave(90_000e6);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(NotAtQueueHead.selector, bob, alice));
        vault.claim();

        assertEq(usdc.balanceOf(bob), 1_000_000e6, "bob is behind alice and stays there");
    }

    /// @dev A head the reserve cannot cover stalls the whole line — an accepted cost of whole-fill,
    ///      and the reason the redeemer is given a way out of it.
    function test_queue_headStallsTheLineAndCancelIsTheExit() public {
        _deposit(alice, 100_000e6);
        vault.receiveMessage(_redeemVaaSalted(alice, 50_000e6, PsmPayload.KIND_REDEEM, 1));
        vault.receiveMessage(_redeemVaaSalted(bob, 1_000e6, PsmPayload.KIND_REDEEM, 2));

        _borrowFromAave(80_000e6);
        uint256 credited = 50_000e6 - 25e6;

        assertEq(vault.drain(10), 0, "the head cannot be covered, so nothing is paid");
        assertEq(vault.owed(alice), credited, "her credit is untouched");
        assertEq(usdc.balanceOf(bob), 1_000_000e6, "and bob is stuck behind her");

        // Alice walks away from the stall. Her HOLLAR is re-minted, gross, on Hydration.
        (bool found, uint256 index,) = vault.queueEntryOf(alice);
        assertTrue(found);
        uint256 principalBefore = vault.principal();

        vm.prank(alice);
        vault.cancelQueuedRedemption(index);

        assertEq(vault.owed(alice), 0, "no longer owed USDC");
        assertEq(vault.principal(), principalBefore + 50_000e6, "gross returns to backing");

        (uint8 kind,, uint256 amount) = PsmPayload.decode(wormhole.lastPublished().payload);
        assertEq(kind, PsmPayload.KIND_MINT, "a mint goes back to Hydration");
        assertEq(amount, 50_000e6, "for the gross, not the net");

        // With the head gone, bob is reachable again.
        assertEq(vault.drain(10), 1_000e6 - 5e5, "bob is paid");
        _assertSolvent();
    }

    function test_queue_drainPaysInArrivalOrder() public {
        _deposit(alice, 100_000e6);
        vault.receiveMessage(_redeemVaaSalted(alice, 1_000e6, PsmPayload.KIND_REDEEM, 1));
        vault.receiveMessage(_redeemVaaSalted(bob, 2_000e6, PsmPayload.KIND_REDEEM, 2));
        vault.receiveMessage(_redeemVaaSalted(carol, 3_000e6, PsmPayload.KIND_REDEEM, 3));

        vault.drain(10);

        assertEq(vault.totalOwed(), 0, "all three paid");
        assertEq(vault.queueLength(), 0);
        _assertSolvent();
    }

    function test_queue_drainRespectsMaxEntries() public {
        _deposit(alice, 100_000e6);
        vault.receiveMessage(_redeemVaaSalted(alice, 1_000e6, PsmPayload.KIND_REDEEM, 1));
        vault.receiveMessage(_redeemVaaSalted(bob, 2_000e6, PsmPayload.KIND_REDEEM, 2));

        vault.drain(1);

        assertEq(vault.owed(alice), 0, "head settled");
        assertGt(vault.owed(bob), 0, "the rest waits for the next call");
    }

    function test_positionOf_reportsOrder() public {
        _deposit(alice, 100_000e6);
        vault.receiveMessage(_redeemVaaSalted(alice, 1_000e6, PsmPayload.KIND_REDEEM, 1));
        vault.receiveMessage(_redeemVaaSalted(bob, 2_000e6, PsmPayload.KIND_REDEEM, 2));

        (bool foundAlice, uint256 posAlice,) = vault.queueEntryOf(alice);
        (bool foundBob, uint256 posBob,) = vault.queueEntryOf(bob);
        assertTrue(foundAlice);
        assertEq(posAlice, 0);
        assertTrue(foundBob);
        assertEq(posBob, 1);
    }

    // ─── Claim ──────────────────────────────────────────────────

    /// Whole-fill: a credit is paid in full or not at all. Part-paying the head would consume the
    /// liquidity everyone behind it is waiting on without ever clearing the line.
    function test_claim_paysWholeCreditOrNothing() public {
        _deposit(alice, 10_000e6);
        vault.receiveMessage(_redeemVaa(alice, 1_000e6, PsmPayload.KIND_REDEEM));
        uint256 credited = 1_000e6 - 5e5;

        _borrowFromAave(9_800e6);
        assertLt(vault.claimable(alice), credited, "the reserve cannot cover the whole credit");
        assertEq(vault.claimable(alice), 0, "and so nothing is claimable");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(InsufficientLiquidity.selector, credited, 200e6));
        vault.claim();
        assertEq(vault.owed(alice), credited, "the credit is untouched");

        _repayToAave(9_800e6);

        vm.prank(alice);
        vault.claim();
        assertEq(vault.owed(alice), 0);
        assertEq(vault.totalOwed(), 0);
        _assertSolvent();
    }

    /// @dev If Aave cannot fill, the claim reverts and the IOU stands. Consuming a credit we did
    ///      not pay would be the one unrecoverable bookkeeping error on this side.
    function test_claim_leavesIouStandingWhenAaveCannotFill() public {
        _deposit(alice, 10_000e6);
        vault.receiveMessage(_redeemVaa(alice, 1_000e6, PsmPayload.KIND_REDEEM));
        pool.setWithdrawReverts(true);

        vm.prank(alice);
        vm.expectRevert();
        vault.claim();

        assertEq(vault.owed(alice), 1_000e6 - 5e5, "the claim survives the failure");
    }

    function test_claim_respectsClaimsPause() public {
        _deposit(alice, 10_000e6);
        vault.receiveMessage(_redeemVaa(alice, 1_000e6, PsmPayload.KIND_REDEEM));

        vm.prank(guardian);
        vault.setClaimsPaused(true);

        vm.prank(alice);
        vm.expectRevert(ClaimsPaused.selector);
        vault.claim();
    }

    /// @dev `drain` is the only path that pays a non-empty queue, and it is permissionless — so a
    ///      pause that misses it is not a pause at all. Regression: it had no check.
    function test_drain_respectsClaimsPause() public {
        _deposit(alice, 10_000e6);
        vault.receiveMessage(_redeemVaa(bob, 1_000e6, PsmPayload.KIND_REDEEM));

        vm.prank(guardian);
        vault.setClaimsPaused(true);

        uint256 before = usdc.balanceOf(bob);
        vm.prank(makeAddr("bystander"));
        vm.expectRevert(ClaimsPaused.selector);
        vault.drain(10);

        assertEq(usdc.balanceOf(bob), before, "no USDC moves while payment is paused");
    }

    // ─── Fee recognition ────────────────────────────────────────

    /// @dev The fee is not earned when the credit books, because the redeemer can still cancel and
    ///      take the gross back. Recognising it early is what let a swept fee become a shortfall.
    function test_credit_doesNotRecogniseFeeAsSurplus() public {
        _deposit(alice, 100_000e6);
        uint256 before = vault.surplus();

        vault.receiveMessage(_redeemVaa(alice, 100_000e6, PsmPayload.KIND_REDEEM));

        assertEq(vault.surplus(), before, "the fee is not surplus until the claim is paid");
        assertEq(vault.totalOwed(), 100_000e6, "liabilities hold the gross, not the net");
        assertEq(vault.owed(alice), 100_000e6 - 50e6, "the recipient is owed the net");
        _assertSolvent();
    }

    /// @dev And it IS earned once delivery happens.
    function test_settle_releasesFeeToSurplusOnPayout() public {
        _deposit(alice, 100_000e6);
        vault.receiveMessage(_redeemVaa(alice, 100_000e6, PsmPayload.KIND_REDEEM));

        uint256 before = vault.surplus();
        vm.prank(alice);
        vault.claim();

        assertEq(vault.surplus() - before, 50e6, "fee lands as surplus exactly at delivery");
        _assertSolvent();
    }

    /// @dev The exploit: book a credit, let the treasurer sweep the fee it created, then cancel and
    ///      take the gross back. The swept fee is unrecoverable, so the reserve ends up short.
    function test_sweepThenCancelLeavesNoShortfall() public {
        _deposit(alice, 200_000e6);
        _deposit(bob, 1e6);

        vault.receiveMessage(_redeemVaa(alice, 200_000e6, PsmPayload.KIND_REDEEM));

        uint256 sweepable = vault.sweepable();
        if (sweepable > 0) {
            vm.prank(treasurer);
            vault.sweepSurplus(sweepable, makeAddr("treasury"));
        }
        _assertSolvent();

        (bool found, uint256 index,) = vault.queueEntryOf(alice);
        assertTrue(found);
        vm.prank(alice);
        vault.cancelQueuedRedemption(index);

        _assertSolvent();
    }

    /// @dev Credits still land while claims are paused: pausing stops payment, not accounting.
    function test_creditsStillLandWhileClaimsPaused() public {
        _deposit(alice, 10_000e6);
        vm.prank(guardian);
        vault.setClaimsPaused(true);

        vault.receiveMessage(_redeemVaa(bob, 100e6, PsmPayload.KIND_REDEEM));
        assertGt(vault.owed(bob), 0);
    }

    function test_claimable_boundedByAaveLiquidity() public {
        _deposit(alice, 100_000e6);
        vault.receiveMessage(_redeemVaa(alice, 50_000e6, PsmPayload.KIND_REDEEM));
        _borrowFromAave(90_000e6);

        // Aave can release 10,000 against a 49,975 credit. Whole-fill means that is not a part
        // payment, it is no payment -- reporting 10,000 would promise a payout `claim` refuses.
        assertEq(vault.claimable(alice), 0, "short of the whole credit is not claimable");

        _repayToAave(90_000e6);
        assertEq(vault.claimable(alice), 50_000e6 - 25e6, "payable in full once liquidity returns");
    }

    // ─── No size threshold ──────────────────────────────────────

    /// @dev No size threshold may bypass the queue. A small credit is queued like any other — it
    ///      is not paid instantly by virtue of being small.
    function test_smallCreditIsQueuedNotPaid() public {
        _deposit(alice, 100_000e6);

        vault.receiveMessage(_redeemVaa(bob, 50e6, PsmPayload.KIND_REDEEM));

        assertEq(usdc.balanceOf(bob), 1_000_000e6, "still nothing moved");
        assertEq(vault.queueLength(), 1);
    }

    // ─── Disputed ───────────────────────────────────────────────

    function test_resolveDisputed_canCreditOrWriteOff() public {
        _deposit(alice, 100e6);
        vault.receiveMessage(_redeemVaaSalted(bob, 500e6, PsmPayload.KIND_REDEEM, 1));
        vault.receiveMessage(_redeemVaaSalted(carol, 500e6, PsmPayload.KIND_REDEEM, 2));

        vm.startPrank(admin);
        vault.resolveDisputed(bob, 500e6, true);
        vault.resolveDisputed(carol, 500e6, false);
        vm.stopPrank();

        assertEq(vault.owed(bob), 500e6, "governance decided to honour it");
        assertEq(vault.owed(carol), 0, "and to write this one off");
        assertEq(vault.disputed(bob), 0);
        assertEq(vault.disputed(carol), 0);
    }

    // ─── Surplus ────────────────────────────────────────────────


    function test_sweepSurplus_boundedByFloor() public {
        _deposit(alice, 100_000e6);
        usdc.mint(address(aUsdc), 1_000e6);
        aUsdc.mint(address(vault), 1_000e6);

        uint256 floorAmount = (100_000e6 * 25) / 10_000;
        assertEq(vault.sweepable(), 1_000e6 - floorAmount);

        vm.prank(treasurer);
        vm.expectRevert(abi.encodeWithSelector(SurplusBelowFloor.selector, 1_000e6, 1_000e6 - floorAmount));
        vault.sweepSurplus(1_000e6, treasurer);

        vm.prank(treasurer);
        vault.sweepSurplus(1_000e6 - floorAmount, treasurer);

        assertEq(usdc.balanceOf(treasurer), 1_000e6 - floorAmount);
        _assertSolvent();
    }

    function test_sweepSurplus_onlyTreasurer() public {
        vm.prank(admin);
        vm.expectRevert();
        vault.sweepSurplus(1, admin);
    }

    // ─── Guardian bounds ────────────────────────────────────────

    /// @dev A compromised guardian's worst case is forgone yield, never a missing reserve.
    function test_emergencyUnwind_cannotMoveFundsOut() public {
        _deposit(alice, 10_000e6);

        vm.prank(guardian);
        vault.emergencyUnwindAave(10_000e6);

        assertEq(usdc.balanceOf(address(vault)), 10_000e6, "out of Aave, still here");
        assertEq(aUsdc.balanceOf(address(vault)), 0);
        _assertSolvent();
    }

    /// @dev And the reserve stays payable from idle balance afterwards.
    function test_claim_paysFromIdleAfterUnwind() public {
        _deposit(alice, 10_000e6);
        vault.receiveMessage(_redeemVaa(alice, 1_000e6, PsmPayload.KIND_REDEEM));

        vm.prank(guardian);
        vault.emergencyUnwindAave(10_000e6);
        pool.setWithdrawReverts(true);

        vm.prank(alice);
        vault.claim();

        assertEq(vault.owed(alice), 0);
    }

    // ─── Housekeeping ───────────────────────────────────────────

    function test_rescueToken_refusesReserveAssets() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(ProtectedToken.selector, address(usdc)));
        vault.rescueToken(address(usdc), admin);

        vm.expectRevert(abi.encodeWithSelector(ProtectedToken.selector, address(aUsdc)));
        vault.rescueToken(address(aUsdc), admin);
        vm.stopPrank();
    }

    function test_setHydrationEmitter_isOneShot() public {
        vm.prank(admin);
        vm.expectRevert(EmitterAlreadySet.selector);
        vault.setHydrationEmitter(bytes32(uint256(0xdead)));
    }

    function test_inheritedOwnerIsRetired() public {
        assertEq(vault.owner(), address(0));

        vm.prank(admin);
        vm.expectRevert(MessageReceiver.NotOwner.selector);
        vault.setAuthorizedEmitter(HYDRATION_CHAIN, bytes32(uint256(0xdead)));
    }

    function test_setFees_capped() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(FeeTooHigh.selector, 501));
        vault.setFees(501, 25);
    }

    // ─── Round trip ─────────────────────────────────────────────

    /// @dev Deposit, redeem, claim. The fee is the only thing that stays behind.
    function testFuzz_roundTripLeavesOnlyTheFee(uint64 rawAmount) public {
        uint256 amount = bound(rawAmount, 10e6, 500_000e6);

        _deposit(alice, amount);
        vault.receiveMessage(_redeemVaa(alice, amount, PsmPayload.KIND_REDEEM));

        uint256 fee = (amount * 5) / 10_000;
        assertEq(vault.principal(), 0, "everything attested came back");
        assertEq(vault.owed(alice), amount - fee);

        vm.prank(alice);
        vault.claim();

        assertEq(vault.totalOwed(), 0);
        assertEq(vault.surplus(), fee, "the fee, and nothing else");
        _assertSolvent();
    }

    /// The inherited emitter check treats the mapping default as a valid key, so a zero-emitter VAA
    /// passes on any chain nobody bound. Only Hydration is ever bound here.
    function test_receiveRedeem_refusesZeroEmitterOnAnUnboundChain() public {
        _deposit(alice, 10_000e6);

        bytes memory payload =
            PsmPayload.encode(PsmPayload.KIND_REDEEM, PsmPayload.fromAddress(alice), 1_000e6);

        vm.expectRevert(abi.encodeWithSelector(UnexpectedEmitterChain.selector, uint16(99)));
        vault.receiveMessage(abi.encode(uint16(99), bytes32(0), payload, uint256(1)));

        vm.expectRevert(abi.encodeWithSelector(UnexpectedEmitterChain.selector, uint16(0)));
        vault.receiveMessage(abi.encode(uint16(0), bytes32(0), payload, uint256(2)));

        assertEq(vault.totalOwed(), 0, "nothing credited");
        assertEq(vault.principal(), 10_000e6, "and the books are untouched");
    }
}
