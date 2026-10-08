// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {HollarBaseVault} from "../../../src/psm/HollarBaseVault.sol";
import {IFiatToken} from "../../../src/psm/interfaces/IFiatToken.sol";
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

/// @title HollarBaseVault, payout limit
/// @notice Payment against credits is held to a gross rate limit of the vault's own, so a forged or
///         faulty message that skips the facilitator's outbound limit still meets a ceiling. What is
///         under test: what spends it and what does not, that waiting never fails a credit, and
///         that no mix of deposits and calls pays past it.
contract PayoutLimitTest is Test, IHollarBaseVault {
    HollarBaseVault internal vault;
    MockToken internal usdc;
    MockAToken internal aUsdc;
    MockAavePool internal pool;
    MockAddressesProvider internal provider;
    MockWormholeCore internal wormhole;

    uint16 internal constant BASE_CHAIN = 30;
    uint16 internal constant HYDRATION_CHAIN = 73;
    bytes32 internal constant HYDRATION_EMITTER = bytes32(uint256(0x4bd7a));
    uint256 internal constant MIN_PRICE = 99e6;

    /// @dev The launch sizing: 10,000 USDC per 24 h, as the facilitator's outbound limit and the
    ///      deposit limit.
    uint256 internal constant CAPACITY = 10_000e6;
    uint256 internal constant WINDOW = 1 days;

    /// @dev Times are absolute and never re-read from `block.timestamp` after a warp: solc may keep
    ///      a cached timestamp across an external call, which is sound on-chain and false under
    ///      `vm.warp`. Every payment below that precedes a warp happens at `T0`.
    uint256 internal constant T0 = 365 days;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal treasurer = makeAddr("treasurer");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal mallory = makeAddr("mallory");
    address internal payee = makeAddr("payee");
    address internal redeemer = makeAddr("redeemer");

    function setUp() public {
        vm.warp(T0);

        wormhole = new MockWormholeCore(BASE_CHAIN, 0);
        usdc = new MockToken("USDC", 6);
        aUsdc = new MockAToken();
        pool = new MockAavePool(usdc, aUsdc);
        MockAggregator aggregator = new MockAggregator(int256(1e8));
        provider = new MockAddressesProvider(
            address(pool), address(new MockAaveOracle(address(new MockCappedAdapter(aggregator)), aggregator))
        );

        vault = HollarBaseVault(address(new ERC1967Proxy(address(new HollarBaseVault()), _initData())));

        vm.startPrank(admin);
        vault.setHydrationEmitter(HYDRATION_EMITTER);
        vault.setDepositLimit(RateLimiter.UNLIMITED, 0);
        vault.setPayoutLimit(CAPACITY, WINDOW);
        vm.stopPrank();

        vm.prank(guardian);
        vault.setDepositsPaused(false);

        usdc.mint(alice, 1_000_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        usdc.mint(mallory, 1_000_000e6);
        vm.prank(mallory);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ─── Helpers ────────────────────────────────────────────────

    function _initData() internal view returns (bytes memory) {
        return abi.encodeCall(
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
        );
    }

    function _deposit(address who, uint256 amount) internal {
        vm.prank(who);
        vault.deposit(amount, PsmPayload.fromAddress(who));
    }

    /// @dev The emitter delivers a redemption credit for `to`. The salt is the sequence.
    function _credit(address to, uint256 amount, uint256 salt) internal {
        vault.receiveMessage(
            VaaBuilder.buildSalted(
                HYDRATION_CHAIN,
                HYDRATION_EMITTER,
                PsmPayload.encode(PsmPayload.KIND_REDEEM, PsmPayload.fromAddress(to), amount, PsmPayload.fromAddress(to)),
                salt
            )
        );
    }

    /// @dev A credit whose Hydration origin is not its recipient, with a fee limit.
    function _creditFor(address to, address origin, uint256 amount, uint256 salt, uint16 cap) internal {
        vault.receiveMessage(
            VaaBuilder.buildSalted(
                HYDRATION_CHAIN,
                HYDRATION_EMITTER,
                PsmPayload.encode(
                    PsmPayload.KIND_REDEEM, PsmPayload.fromAddress(to), amount, PsmPayload.fromAddress(origin), cap
                ),
                salt
            )
        );
    }

    /// @dev What a credit of `gross` pays out: net of the 5 bps fee.
    function _net(uint256 gross) internal pure returns (uint256) {
        return gross - (gross * 5) / 10_000;
    }

    /// @dev Circle blacklisting `who`: every transfer to them reverts and `isBlacklisted` says so.
    ///      Undone with `vm.clearMockedCalls()`.
    function _blacklist(address who) internal {
        vm.mockCallRevert(
            address(usdc), abi.encodeWithSelector(MockToken.transfer.selector, who), "Blacklistable: account is blacklisted"
        );
        vm.mockCall(address(usdc), abi.encodeWithSelector(IFiatToken.isBlacklisted.selector, who), abi.encode(true));
    }

    function _assertSolvent() internal view {
        uint256 assets = usdc.balanceOf(address(vault)) + aUsdc.balanceOf(address(vault));
        uint256 liabilities = vault.principal() + vault.totalOwed() + vault.totalUnpayable();
        assertGe(assets, liabilities, "assets must cover principal + owed + delayed");
    }

    // ─── Init ───────────────────────────────────────────────────

    /// @dev Unset means closed, never unlimited, as for the deposit limit. A vault whose budget has
    ///      not been set still books credits and pays none, and the first set starts the budget full.
    function test_initialize_shipsTheLimitClosed() public {
        vault = HollarBaseVault(address(new ERC1967Proxy(address(new HollarBaseVault()), _initData())));
        assertEq(vault.payoutAllowance(), 0, "unset reads as closed");

        vm.startPrank(admin);
        vault.setHydrationEmitter(HYDRATION_EMITTER);
        vault.setDepositLimit(RateLimiter.UNLIMITED, 0);
        vm.stopPrank();
        vm.prank(guardian);
        vault.setDepositsPaused(false);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);

        _deposit(alice, 50_000e6);
        _credit(bob, 2_000e6, 1);
        assertEq(vault.owed(bob), _net(2_000e6), "the credit books");
        assertEq(vault.drain(10), 0, "and nothing is paid");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(InsufficientPayoutAllowance.selector, _net(2_000e6), 0));
        vault.claim();

        vm.prank(admin);
        vault.setPayoutLimit(CAPACITY, WINDOW);
        assertEq(vault.payoutAllowance(), CAPACITY, "the first set starts full");
        assertEq(vault.drain(10), _net(2_000e6), "and the credit pays");
    }

    // ─── What spends it ─────────────────────────────────────────

    function test_drain_spendsThePayoutLimit() public {
        _deposit(alice, 50_000e6);
        _credit(bob, 2_000e6, 1);
        _credit(carol, 3_000e6, 2);

        uint256 paid = vault.drain(10);

        assertEq(paid, _net(2_000e6) + _net(3_000e6), "both were paid");
        assertEq(vault.payoutAllowance(), CAPACITY - paid, "and the limit fell by exactly what left");
    }

    function test_claim_spendsThePayoutLimit() public {
        _deposit(alice, 50_000e6);
        _credit(bob, 2_000e6, 1);

        vm.prank(bob);
        vault.claim();

        assertEq(usdc.balanceOf(bob), _net(2_000e6));
        assertEq(vault.payoutAllowance(), CAPACITY - _net(2_000e6), "the claim spent what it was paid");
    }

    function test_claimUnpayable_spendsThePayoutLimit() public {
        _deposit(alice, 50_000e6);
        _credit(mallory, 2_000e6, 1);
        _blacklist(mallory);
        vault.drain(10);
        vm.clearMockedCalls();

        vault.claimUnpayable(mallory);

        assertEq(usdc.balanceOf(mallory), 1_000_000e6 + _net(2_000e6), "paid once the block cleared");
        assertEq(vault.payoutAllowance(), CAPACITY - _net(2_000e6), "and the retired credit spent the limit then");
    }

    /// @dev Retiring a credit moves no money, so it spends nothing. Only what is paid beside it does.
    function test_retirementSpendsNothing() public {
        _deposit(alice, 50_000e6);
        _credit(mallory, 2_000e6, 1);
        _credit(bob, 3_000e6, 2);
        _blacklist(mallory);

        uint256 paid = vault.drain(10);

        assertEq(vault.unpayable(mallory), _net(2_000e6), "retired, still owed");
        assertEq(paid, _net(3_000e6), "bob alone was paid");
        assertEq(vault.payoutAllowance(), CAPACITY - _net(3_000e6), "only bob's payment spent anything");
    }

    /// @dev Gross. A deposit of any size gives nothing back, so a ceiling cannot be raised by
    ///      depositing.
    function test_depositsDoNotRefillThePayoutLimit() public {
        _deposit(alice, 50_000e6);
        _credit(bob, 8_000e6, 1);
        vault.drain(10);
        uint256 left = vault.payoutAllowance();
        assertEq(left, CAPACITY - _net(8_000e6));

        _deposit(alice, 100_000e6);
        _deposit(mallory, 100_000e6);
        assertEq(vault.payoutAllowance(), left, "a deposit gives nothing back");

        _credit(carol, 5_000e6, 2);
        assertEq(vault.drain(10), 0, "so a credit it cannot cover still waits, deposit or no deposit");
        assertEq(vault.owed(carol), _net(5_000e6));
    }

    // ─── What does not spend it ─────────────────────────────────

    /// @dev The treasurer's sweep is an admin path, not a credit payout. Its own bound is the
    ///      surplus floor, and a sweep larger than the whole limit goes through.
    function test_sweepSurplus_doesNotSpendThePayoutLimit() public {
        _deposit(alice, 100_000e6);
        usdc.mint(address(aUsdc), 30_000e6);
        aUsdc.mint(address(vault), 30_000e6);
        uint256 sweepable = vault.sweepable();
        assertGt(sweepable, CAPACITY, "more than the limit would let a payout take");

        vm.prank(treasurer);
        vault.sweepSurplus(sweepable, treasurer);

        assertEq(usdc.balanceOf(treasurer), sweepable);
        assertEq(vault.payoutAllowance(), CAPACITY, "nothing spent");
    }

    /// @dev A cancel moves no USDC: the HOLLAR is re-minted on Hydration instead.
    function test_cancelQueuedRedemption_doesNotSpendThePayoutLimit() public {
        _deposit(alice, 50_000e6);
        _credit(bob, 2_000e6, 1);

        vm.prank(bob);
        vault.cancelQueuedRedemption(0);

        assertEq(vault.payoutAllowance(), CAPACITY, "nothing spent");
    }

    /// @dev The limit meters payment only. A credit's cancel leaves as a re-mint on Hydration, which
    ///      the facilitator's inbound limit and its bucket bound there. With payment closed,
    ///      credits worth three times the whole limit are each cancelled at once: every re-mint
    ///      goes out at the gross, `principal` is back where it was each time, and the allowance
    ///      never moves.
    function test_cancelOfACredit_isNotMeteredByThePayoutLimit() public {
        _deposit(alice, 100_000e6);
        vm.prank(admin);
        vault.setPayoutLimit(0, 0);

        uint256 reminted;
        for (uint256 i = 1; i <= 3; i++) {
            _credit(bob, 10_000e6, i);
            uint256 index = vault.queueHead();
            vm.prank(bob);
            vault.cancelQueuedRedemption(index);

            (uint8 kind, bytes32 to, uint256 amount,) = PsmPayload.decode(wormhole.lastPublished().payload);
            assertEq(kind, PsmPayload.KIND_REMINT);
            assertEq(to, PsmPayload.fromAddress(bob));
            reminted += amount;
        }
        assertEq(reminted, 30_000e6, "three capacities re-minted while payment is closed");
        assertEq(vault.principal(), 100_000e6, "principal is back where it was");
        assertEq(vault.payoutAllowance(), 0, "and the payout limit never moved");
    }

    /// @dev Nor is a fee-limit return. A redemption above its own fee limit goes back as a re-mint
    ///      in the same delivery and `principal` is never reduced, so with payment closed a
    ///      redemption of the whole deposit goes back three times over.
    function test_feeLimitReturn_isNotMeteredByThePayoutLimit() public {
        _deposit(alice, 100_000e6);
        vm.prank(admin);
        vault.setPayoutLimit(0, 0);

        uint256 returned;
        for (uint256 i = 1; i <= 3; i++) {
            _creditFor(bob, bob, 100_000e6, i, 0); // a fee limit of zero is below the 5 bps fee
            (uint8 kind,, uint256 amount,) = PsmPayload.decode(wormhole.lastPublished().payload);
            assertEq(kind, PsmPayload.KIND_REMINT);
            returned += amount;
        }
        assertEq(returned, 300_000e6, "three times the deposit goes back while payment is closed");
        assertEq(vault.principal(), 100_000e6, "nothing was booked");
        assertEq(vault.queueLength(), 0);
        assertEq(vault.payoutAllowance(), 0);
    }

    // ─── Waiting ────────────────────────────────────────────────

    /// @dev Over the limit nothing reverts and nothing is part-paid: `drain` stops at the head, in
    ///      order, and the rest waits for the window. A later credit that would fit does not pass it.
    function test_drain_stopsAtTheLimitWithoutRevertingAndPaysAfterTheWindow() public {
        _deposit(alice, 100_000e6);
        _credit(bob, 6_000e6, 1);
        _credit(carol, 6_000e6, 2);
        _credit(dave, 1_000e6, 3);

        uint256 paid = vault.drain(10);

        assertEq(paid, _net(6_000e6), "bob only");
        assertEq(vault.owed(carol), _net(6_000e6), "carol waits");
        assertEq(vault.owed(dave), _net(1_000e6), "and dave waits behind her, though he would fit");
        assertEq(vault.queueLength(), 2);

        // The refill is continuous: four hours is not yet enough for carol.
        vm.warp(T0 + 4 hours);
        assertEq(vault.drain(10), 0, "still short, still no revert");
        assertEq(vault.queueLength(), 2);

        vm.warp(T0 + 1 days);
        assertEq(vault.drain(10), _net(6_000e6) + _net(1_000e6), "the rest is paid once the window has refilled");
        assertEq(vault.queueLength(), 0);
        _assertSolvent();
    }

    function test_claim_revertsWhenTheAllowanceCannotCoverTheHead() public {
        _deposit(alice, 100_000e6);
        _credit(bob, 6_000e6, 1);
        _credit(carol, 6_000e6, 2);
        vault.drain(1);

        vm.prank(carol);
        vm.expectRevert(
            abi.encodeWithSelector(InsufficientPayoutAllowance.selector, _net(6_000e6), CAPACITY - _net(6_000e6))
        );
        vault.claim();
        assertEq(vault.owed(carol), _net(6_000e6), "the credit is untouched");
        (address head,) = vault.queueHeadEntry();
        assertEq(head, carol, "and still at the head");

        vm.warp(T0 + 1 days);
        vm.prank(carol);
        vault.claim();
        assertEq(usdc.balanceOf(carol), _net(6_000e6), "paid once the window has refilled");
    }

    function test_claimUnpayable_revertsWhenTheAllowanceCannotCoverIt() public {
        _deposit(alice, 100_000e6);
        _credit(mallory, 6_000e6, 1);
        _credit(bob, 6_000e6, 2);
        _blacklist(mallory);
        vault.drain(10);
        vm.clearMockedCalls();

        vm.expectRevert(
            abi.encodeWithSelector(InsufficientPayoutAllowance.selector, _net(6_000e6), CAPACITY - _net(6_000e6))
        );
        vault.claimUnpayable(mallory);
        assertEq(vault.unpayable(mallory), _net(6_000e6), "still owed");
        assertEq(vault.totalUnpayable(), _net(6_000e6));

        vm.warp(T0 + 1 days);
        vault.claimUnpayable(mallory);
        assertEq(usdc.balanceOf(mallory), 1_000_000e6 + _net(6_000e6));
        assertEq(vault.totalUnpayable(), 0);
    }

    /// @dev The burn on Hydration cannot be undone, so booking must never depend on the allowance.
    ///      With payment closed outright, credits still land; and reopening starts the allowance
    ///      empty, as it does for any limit.
    function test_setPayoutLimit_zeroClosesItAndCreditsStillBook() public {
        _deposit(alice, 50_000e6);

        vm.prank(admin);
        vault.setPayoutLimit(0, 0);
        assertEq(vault.payoutAllowance(), 0);

        _credit(bob, 2_000e6, 1);
        assertEq(vault.owed(bob), _net(2_000e6), "booked all the same");
        assertEq(vault.queueLength(), 1);

        assertEq(vault.drain(10), 0, "nothing is paid, and nothing reverts");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(InsufficientPayoutAllowance.selector, _net(2_000e6), 0));
        vault.claim();

        vm.prank(admin);
        vault.setPayoutLimit(CAPACITY, WINDOW);
        assertEq(vault.payoutAllowance(), 0, "reopened empty");
        vm.warp(T0 + WINDOW);
        assertEq(vault.drain(10), _net(2_000e6), "and paid once it has refilled");
    }

    /// @dev `claimable` reports what `claim` would pay, so it cannot promise past the allowance.
    function test_claimable_boundedByThePayoutAllowance() public {
        _deposit(alice, 100_000e6);
        _credit(bob, 6_000e6, 1);
        _credit(carol, 6_000e6, 2);
        assertEq(vault.claimable(bob), _net(6_000e6));

        vault.drain(1);
        assertEq(vault.claimable(carol), 0, "the allowance cannot cover her, so nothing is claimable");

        vm.warp(T0 + 1 days);
        assertEq(vault.claimable(carol), _net(6_000e6), "claimable once the window has refilled");
    }

    /// @dev The allowance is checked against the whole entry before the transfer is tried, so a
    ///      blacklisted head it cannot cover is not retired, though retiring it spends nothing. It
    ///      holds the credits behind it, one of which would fit, until the allowance reaches it.
    function test_drain_blacklistedHeadWaitsForAllowanceItWillNotSpend() public {
        _deposit(alice, 100_000e6);
        _credit(dave, 8_000e6, 1);
        _credit(mallory, 6_000e6, 2);
        _credit(bob, 1_000e6, 3);
        _blacklist(mallory);

        assertEq(vault.drain(10), _net(8_000e6), "dave is paid");
        // 2,004 is left. Mallory's 5,997 stops the loop, so bob's 999.5 waits behind her.
        assertEq(vault.drain(10), 0);
        assertEq(vault.unpayable(mallory), 0, "not retired");
        (address head,) = vault.queueHeadEntry();
        assertEq(head, mallory);
        assertLe(_net(1_000e6), vault.payoutAllowance(), "bob alone would have fit");

        // Once the allowance reaches her entry she retires, spending nothing, and bob is paid.
        vm.warp(T0 + 10 hours);
        uint256 before = vault.payoutAllowance();
        assertGe(before, _net(6_000e6));
        assertEq(vault.drain(10), _net(1_000e6));
        assertEq(vault.unpayable(mallory), _net(6_000e6));
        assertEq(vault.payoutAllowance(), before - _net(1_000e6), "the retirement spent nothing");
    }

    /// @dev `claimUnpayable` competes with the queue for the allowance and pays whole, so a retired
    ///      balance below the capacity waits while queue payments spend each refill.
    function test_claimUnpayable_waitsWhileQueuePaymentsSpendTheRefill() public {
        _deposit(alice, 500_000e6);
        _credit(mallory, 6_000e6, 1);
        _blacklist(mallory);
        vault.drain(10);
        vm.clearMockedCalls();
        _credit(dave, 10_000e6, 2);
        vault.drain(10); // the window is spent

        uint256 clock = T0;
        for (uint256 k; k < 20; k++) {
            _credit(bob, 1_000e6, 100 + k);
            clock += 2 hours + 24 minutes; // 1,000 of refill
            vm.warp(clock);
            vm.expectPartialRevert(InsufficientPayoutAllowance.selector);
            vault.claimUnpayable(mallory);
            vault.drain(10);
        }
        assertEq(vault.unpayable(mallory), _net(6_000e6), "two days of steady payouts and still waiting");

        clock += 15 hours;
        vm.warp(clock);
        vault.claimUnpayable(mallory);
        assertEq(vault.unpayable(mallory), 0, "paid once the queue went quiet");
    }

    // ─── Sizing ─────────────────────────────────────────────────

    /// @dev A credit larger than the capacity is never covered, however long it waits. That is the
    ///      sizing condition: the capacity must not sit below an honest credit. The exit is the one
    ///      a head larger than the reserve has, the redeemer's cancel or the admin's.
    function test_aCreditAboveTheCapacityStallsTheHeadUntilCancelled() public {
        _deposit(alice, 100_000e6);
        _credit(bob, 12_000e6, 1);
        _credit(dave, 12_000e6, 2);
        _credit(carol, 1_000e6, 3);

        vm.warp(T0 + 30 days);
        assertEq(vault.drain(10), 0, "no window ever covers it");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(InsufficientPayoutAllowance.selector, _net(12_000e6), CAPACITY));
        vault.claim();
        assertEq(vault.owed(carol), _net(1_000e6), "and everyone behind it waits");

        vm.prank(bob);
        vault.cancelQueuedRedemption(0);
        (uint8 kind,, uint256 amount,) = PsmPayload.decode(wormhole.lastPublished().payload);
        assertEq(kind, PsmPayload.KIND_REMINT);
        assertEq(amount, 12_000e6, "the redeemer's HOLLAR goes back, gross");

        vm.prank(admin);
        vault.cancelQueuedRedemptionFor(1);

        assertEq(vault.drain(10), _net(1_000e6), "with the stall gone the queue moves on");
        _assertSolvent();
    }

    /// @dev A recipient's retired credits are one balance. Two credits that each fit the capacity
    ///      merge into one that does not, and there is no cancel from `unpayable`. The way out is a
    ///      raise, which if finite grants nothing at once: the level carries over and refills toward
    ///      the new capacity.
    function test_claimUnpayable_mergedBalanceAboveTheCapacityWaitsForARaise() public {
        _deposit(alice, 100_000e6);
        _credit(mallory, 6_000e6, 1);
        _credit(mallory, 6_000e6, 2);
        _blacklist(mallory);
        assertEq(vault.drain(10), 0, "both retired");
        vm.clearMockedCalls();

        uint256 merged = 2 * _net(6_000e6);
        assertEq(vault.unpayable(mallory), merged);
        assertGt(merged, CAPACITY, "above what the limit can ever hold");

        vm.warp(T0 + 30 days);
        vm.expectRevert(abi.encodeWithSelector(InsufficientPayoutAllowance.selector, merged, CAPACITY));
        vault.claimUnpayable(mallory);

        vm.prank(admin);
        vault.setPayoutLimit(20_000e6, WINDOW);
        assertEq(vault.payoutAllowance(), CAPACITY, "a finite raise grants nothing at once");
        vm.expectRevert(abi.encodeWithSelector(InsufficientPayoutAllowance.selector, merged, CAPACITY));
        vault.claimUnpayable(mallory);

        vm.warp(T0 + 30 days + 3 hours);
        vault.claimUnpayable(mallory);
        assertEq(usdc.balanceOf(mallory), 1_000_000e6 + merged, "paid once the allowance reached it");
    }

    // ─── The origin's cancel ────────────────────────────────────

    /// @dev The origin's cancel opens `ORIGIN_CANCEL_DELAY` after a credit reaches the head, and the
    ///      payout window is the same 24 h. A head the allowance cannot cover when it arrives
    ///      becomes payable 86 s before that, so a keeper that misses those seconds lets the origin
    ///      recall the payment. Pinned so that a change to either duration shows.
    function test_originCancel_racesThePayoutRefill() public {
        _deposit(alice, 100_000e6);
        _credit(dave, 10_000e6, 1);
        _creditFor(payee, redeemer, 10_000e6, 2, PsmPayload.NO_FEE_CAP);
        assertEq(vault.drain(10), _net(10_000e6), "dave only");
        assertEq(vault.headSince(), T0, "the payee's credit became the head now");

        vm.warp(T0 + 86_313);
        assertEq(vault.claimable(payee), 0, "not yet payable");
        vm.warp(T0 + 86_314);
        assertEq(vault.claimable(payee), _net(10_000e6), "payable at +86,314 s");
        vm.prank(redeemer);
        vm.expectRevert(abi.encodeWithSelector(OriginCancelTooEarly.selector, 1, T0 + 1 days));
        vault.cancelQueuedRedemption(1);

        vm.warp(T0 + 1 days);
        vm.prank(redeemer);
        vault.cancelQueuedRedemption(1);
        assertEq(vault.owed(payee), 0, "recalled by the origin once its delay opened");
    }

    /// @dev Any other spend during that wait, here a `claimUnpayable` that anyone may call, puts
    ///      payability past the origin's delay, so the origin's cancel opens first.
    function test_originCancel_opensBeforeTheHeadIsPayable() public {
        _deposit(alice, 100_000e6);
        _credit(mallory, 2_000e6, 1);
        _blacklist(mallory);
        vault.drain(10);
        vm.clearMockedCalls();
        _credit(dave, 10_000e6, 2);
        _creditFor(payee, redeemer, 10_000e6, 3, PsmPayload.NO_FEE_CAP);
        assertEq(vault.drain(10), _net(10_000e6));

        vm.warp(T0 + 12 hours);
        vault.claimUnpayable(mallory); // spends 1,999 of the refill

        vm.warp(T0 + 1 days);
        assertEq(vault.claimable(payee), 0, "not yet payable");
        vm.prank(redeemer);
        vault.cancelQueuedRedemption(2);
        assertEq(vault.owed(payee), 0, "the origin recalled it first");
    }

    // ─── Admin and views ────────────────────────────────────────

    function test_setPayoutLimit_onlyAdmin() public {
        bytes32 adminRole = vault.DEFAULT_ADMIN_ROLE();
        address[3] memory others = [guardian, treasurer, mallory];

        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(
                abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, others[i], adminRole)
            );
            vault.setPayoutLimit(1, 1);
        }

        vm.expectEmit(false, false, false, true, address(vault));
        emit PayoutLimitSet(5_000e6, 12 hours);
        vm.prank(admin);
        vault.setPayoutLimit(5_000e6, 12 hours);
        assertEq(vault.payoutAllowance(), 5_000e6, "a cut applies at once");
    }

    /// @dev The same validation as the deposit limit, and unlimited has to be asked for by name.
    function test_setPayoutLimit_validatesLikeTheDepositLimit() public {
        vm.startPrank(admin);
        vm.expectRevert(RateLimiter.ZeroWindow.selector);
        vault.setPayoutLimit(1, 0);

        uint256 tooLarge = uint256(type(uint128).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(RateLimiter.CapacityTooLarge.selector, tooLarge));
        vault.setPayoutLimit(tooLarge, 1);

        vault.setPayoutLimit(RateLimiter.UNLIMITED, 0);
        vm.stopPrank();
        assertEq(vault.payoutAllowance(), RateLimiter.UNLIMITED);
    }

    /// @dev `UNLIMITED` opens payment at once, and a finite limit set after it starts full, so
    ///      toggling through it hands out a fresh window.
    function test_setPayoutLimit_unlimitedThenFiniteStartsFull() public {
        _deposit(alice, 100_000e6);
        _credit(bob, 10_000e6, 1);
        vault.drain(10);
        assertEq(vault.payoutAllowance(), 5e6, "the window is spent");

        vm.startPrank(admin);
        vault.setPayoutLimit(RateLimiter.UNLIMITED, 0);
        assertEq(vault.payoutAllowance(), RateLimiter.UNLIMITED, "opened at once");
        vault.setPayoutLimit(CAPACITY, WINDOW);
        vm.stopPrank();
        assertEq(vault.payoutAllowance(), CAPACITY, "and a finite limit set after it starts full");
    }

    /// @dev Paused reads as nothing payable, like `claimable` and `depositAllowance` under their pauses.
    function test_payoutAllowance_zeroWhileClaimsPaused() public {
        assertEq(vault.payoutAllowance(), CAPACITY);

        vm.prank(guardian);
        vault.setClaimsPaused(true);
        assertEq(vault.payoutAllowance(), 0);

        vm.prank(guardian);
        vault.setClaimsPaused(false);
        assertEq(vault.payoutAllowance(), CAPACITY, "the pause spent nothing");
    }

    // ─── Forged credits ─────────────────────────────────────────

    /// @dev The reason the limit exists. The emitter delivers credits no burn on Hydration backs,
    ///      each one inside `principal` when it lands, nearly forty times the capacity in all, and
    ///      the recipient deposits before every one to raise its own ceiling. Booking is unchanged,
    ///      so all forty land. Within the window the vault pays out at most the capacity, by
    ///      `drain` or by `claim`, whatever has been deposited in between.
    function test_forgedCreditsPayAtMostTheLimitPerWindow() public {
        _deposit(alice, 100_000e6);

        uint256 paid;
        uint256 deposited;
        for (uint256 i = 1; i <= 40; i++) {
            _deposit(mallory, 1_000e6);
            deposited += 1_000e6;
            _credit(mallory, 1_000e6, i);

            paid += vault.drain(10);
            assertLe(paid, CAPACITY, "inside the window nothing past the capacity is paid");
        }

        assertEq(paid, 10 * _net(1_000e6), "ten whole credits fit; an eleventh would pass the capacity");
        assertEq(vault.queueLength(), 30, "the other thirty are booked and wait");
        assertEq(vault.totalOwed(), 30 * 1_000e6, "still liabilities, at the gross");

        // The recipient is the head and can try to take it by hand. The same ceiling holds.
        vm.prank(mallory);
        vm.expectRevert(
            abi.encodeWithSelector(InsufficientPayoutAllowance.selector, _net(1_000e6), CAPACITY - paid)
        );
        vault.claim();

        // A larger deposit buys nothing either.
        _deposit(mallory, 500_000e6);
        deposited += 500_000e6;
        assertEq(vault.drain(100), 0, "no deposit refills the limit");
        assertEq(vault.payoutAllowance(), CAPACITY - paid);

        // A window later it has refilled by the capacity, and by no more.
        vm.warp(T0 + WINDOW);
        uint256 next = vault.drain(100);
        assertEq(next, 10 * _net(1_000e6), "another ten credits");
        assertLe(paid + next, 2 * CAPACITY, "over two windows, the capacity plus one refill");

        assertEq(usdc.balanceOf(mallory), 1_000_000e6 - deposited + paid + next, "and that is all that left");
        _assertSolvent();
    }

    /// @dev The same bound over arbitrary sequences. Whatever mix of deposits, credits, drains,
    ///      claims and waiting, what has left for credits never passes the capacity plus the refill
    ///      accrued over the time elapsed.
    function testFuzz_forgedCreditsNeverPassTheBucket(uint256 seed) public {
        _deposit(alice, 300_000e6);
        uint256 clock = T0;
        uint256 funded = usdc.balanceOf(mallory);
        uint256 deposited;

        for (uint256 i = 1; i <= 30; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 amount = bound(seed >> 8, 1e6, 6_000e6);
            uint256 op = seed % 5;

            if (op == 0) {
                _deposit(mallory, amount);
                deposited += amount;
            } else if (op == 1) {
                _credit(mallory, amount, i);
            } else if (op == 2) {
                vault.drain(1 + (seed >> 40) % 5);
            } else if (op == 3) {
                vm.prank(mallory);
                try vault.claim() {} catch {}
            } else {
                clock += (seed >> 48) % 8 hours;
                vm.warp(clock);
            }

            uint256 left = usdc.balanceOf(mallory) + deposited - funded;
            assertLe(left, CAPACITY + (CAPACITY * (clock - T0)) / WINDOW, "paid past the bucket");
        }
    }
}
