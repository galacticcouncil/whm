// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
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
    address internal borrower = makeAddr("borrower");

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

    /// @dev The bound is inclusive: a head exactly equal to the allowance pays, by `claim` and by
    ///      `drain`, and leaves nothing.
    function test_aHeadExactlyEqualToTheAllowancePays() public {
        vm.prank(admin);
        vault.setPayoutLimit(_net(4_000e6), WINDOW);
        _deposit(alice, 100_000e6);

        _credit(bob, 4_000e6, 1);
        assertEq(vault.claimable(bob), _net(4_000e6));
        vm.prank(bob);
        vault.claim();
        assertEq(usdc.balanceOf(bob), _net(4_000e6), "paid by claim");
        assertEq(vault.payoutAllowance(), 0);

        vm.warp(T0 + WINDOW);
        _credit(carol, 4_000e6, 2);
        assertEq(vault.drain(10), _net(4_000e6), "paid by drain");
        assertEq(vault.payoutAllowance(), 0);
    }

    function test_limits_reportsBothLimits() public {
        vm.prank(admin);
        vault.setDepositLimit(20_000e6, 12 hours);
        _deposit(alice, 5_000e6);
        _credit(bob, 2_000e6, 1);
        vault.drain(10);

        (uint256 dc, uint256 dw, uint256 da, uint256 pc, uint256 pw, uint256 pa) = vault.limits();
        assertEq(dc, 20_000e6);
        assertEq(dw, 12 hours);
        assertEq(da, 20_000e6 - 5_000e6);
        assertEq(pc, CAPACITY);
        assertEq(pw, WINDOW);
        assertEq(pa, CAPACITY - _net(2_000e6));
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

    /// @dev A balance the allowance cannot cover is paid in part, not refused: the call pays the
    ///      allowance, and the rest stays owed until the window has refilled it.
    function test_claimUnpayable_paysWhatTheAllowanceCoversAndTheRestLater() public {
        _deposit(alice, 100_000e6);
        _credit(mallory, 6_000e6, 1);
        _credit(bob, 6_000e6, 2);
        _blacklist(mallory);
        vault.drain(10);
        vm.clearMockedCalls();

        uint256 allowance = CAPACITY - _net(6_000e6);
        vault.claimUnpayable(mallory);
        assertEq(usdc.balanceOf(mallory), 1_000_000e6 + allowance, "the allowance, paid at once");
        assertEq(vault.unpayable(mallory), _net(6_000e6) - allowance, "the rest still owed");
        assertEq(vault.totalUnpayable(), _net(6_000e6) - allowance);
        assertEq(vault.payoutAllowance(), 0, "the window is spent");

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

    /// @dev `claimUnpayable` competes with the queue for the allowance and pays in part, so whoever
    ///      calls it can take each refill for a retired balance ahead of the queue. The head waits,
    ///      but only until the balance is paid: the queue's extra wait is bounded by the balance.
    function test_claimUnpayable_takesTheRefillAheadOfTheQueueUntilPaid() public {
        _deposit(alice, 500_000e6);
        _credit(mallory, 6_000e6, 1);
        _blacklist(mallory);
        vault.drain(10);
        vm.clearMockedCalls();
        _credit(dave, 10_000e6, 2);
        vault.drain(10); // the window is spent, 5 left
        _credit(bob, 1_000e6, 3);

        uint256 clock = T0;
        uint256 refills;
        while (vault.unpayable(mallory) > 0) {
            clock += 2 hours + 24 minutes; // 1,000 of refill
            vm.warp(clock);
            vault.claimUnpayable(mallory);
            assertEq(vault.drain(10), 0, "the head waits while the retired balance takes the refill");
            refills++;
        }
        assertEq(refills, 6, "5,997 paid from the 5 left and six refills of 1,000");
        assertEq(usdc.balanceOf(mallory), 1_000_000e6 + _net(6_000e6), "all of it, to the recipient");
        assertEq(vault.owed(bob), _net(1_000e6), "and the head still waits");

        clock += 2 hours + 24 minutes;
        vm.warp(clock);
        assertEq(vault.drain(10), _net(1_000e6), "with the balance paid, the queue moves again");
    }

    /// @dev The liquidity side of the same cost. Borrowers hold the whole reserve and repay 100 an
    ///      hour, so liquidity binds and the allowance never does. A 999.5 head is payable from what
    ///      has come back by hour 10, but a cleared 5,997 balance takes each 100 first. The head
    ///      waits until that much more has come back, and is paid at hour 70. Its origin's cancel
    ///      opens at hour 24, while it still waits.
    function test_claimUnpayable_takesReturningLiquidityAheadOfTheQueueUntilPaid() public {
        _deposit(alice, 100_000e6);
        _credit(mallory, 6_000e6, 1);
        _blacklist(mallory);
        vault.drain(10);
        vm.clearMockedCalls();
        vm.prank(guardian);
        vault.setInvestPaused(false); // what the retirement withdrew goes back to Aave
        _creditFor(payee, redeemer, 1_000e6, 2, PsmPayload.NO_FEE_CAP);
        assertEq(vault.headSince(), T0, "the payee's credit became the head now");

        uint256 borrowed = usdc.balanceOf(address(aUsdc));
        vm.prank(borrower);
        pool.drainForBorrow(borrowed);
        assertEq(_liquidity(), 0);

        for (uint256 h = 1; h <= 70; h++) {
            vm.warp(T0 + h * 1 hours);
            vm.prank(borrower);
            usdc.transfer(address(aUsdc), 100e6);

            if (h <= 60) {
                assertLt(_liquidity(), vault.payoutAllowance(), "liquidity binds, not the allowance");
                vault.claimUnpayable(mallory);
            }
            if (h == 10) {
                // What has come back would pay the head by now, and the retired balance took all of it.
                assertGe(h * 100e6, _net(1_000e6));
                assertEq(usdc.balanceOf(mallory) - 1_000_000e6, h * 100e6, "the retired balance took it");
            }
            if (h == 60) assertEq(vault.unpayable(mallory), 0, "5,997 paid from sixty hours of repayments");

            if (h == 24) {
                // The head has sat a day unpaid, so its origin can recall it first.
                uint256 snapshot = vm.snapshotState();
                vm.prank(redeemer);
                vault.cancelQueuedRedemption(1);
                assertEq(vault.owed(payee), 0, "the origin recalls it before it is paid");
                vm.revertToState(snapshot);
            }

            if (h < 70) assertEq(vault.drain(10), 0, "the head waits while the retired balance takes the liquidity");
        }
        assertEq(usdc.balanceOf(mallory), 1_000_000e6 + _net(6_000e6), "the balance was paid first");
        assertEq(vault.drain(10), _net(1_000e6), "the head once that much more had come back");
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
    ///      merge into one that does not, and there is no cancel from `unpayable`. It is paid in
    ///      parts, with no raise: the whole capacity now and the rest from the refill. A raise only
    ///      speeds the refill, and if finite grants nothing at once: the level carries over and
    ///      refills toward the new capacity.
    function test_claimUnpayable_mergedBalanceAboveTheCapacityIsPaidInParts() public {
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
        vault.claimUnpayable(mallory);
        assertEq(usdc.balanceOf(mallory), 1_000_000e6 + CAPACITY, "the whole capacity, at once");
        assertEq(vault.unpayable(mallory), merged - CAPACITY, "the rest still owed");
        vm.expectRevert(abi.encodeWithSelector(InsufficientPayoutAllowance.selector, merged - CAPACITY, 0));
        vault.claimUnpayable(mallory);

        // An hour on, the level has refilled part way. A finite raise keeps that level and grants
        // nothing at once: it refills toward the new capacity from there.
        vm.warp(T0 + 30 days + 1 hours);
        uint256 level = vault.payoutAllowance();
        assertGt(level, 0);
        vm.prank(admin);
        vault.setPayoutLimit(20_000e6, WINDOW);
        assertEq(vault.payoutAllowance(), level, "a finite raise keeps the level and grants nothing at once");

        // One hour at the old rate and two at the new refill 2,083, past the 1,994 left. Three
        // hours at the old rate alone refill 1,250.
        vm.warp(T0 + 30 days + 3 hours);
        vault.claimUnpayable(mallory);
        assertEq(usdc.balanceOf(mallory), 1_000_000e6 + merged, "paid once the allowance reached it");
        assertEq(vault.totalUnpayable(), 0);
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

    // ─── Partial claims from the unpayable balance ──────────────

    /// @dev One `claimUnpayable`, checked against the books. It pays `expected` to `who`, takes
    ///      exactly that from their balance, from `totalUnpayable` and from the allowance, and
    ///      reports it in its event. `surplus()` does not move: assets and liabilities both fall
    ///      by what left.
    function _claimUnpayableExpecting(address who, uint256 expected) internal {
        uint256 balance = vault.unpayable(who);
        uint256 total = vault.totalUnpayable();
        uint256 allowance = vault.payoutAllowance();
        uint256 held = usdc.balanceOf(who);
        uint256 surplusBefore = vault.surplus();

        vm.expectEmit(true, false, false, true, address(vault));
        emit UnpayableClaimed(who, expected);
        vault.claimUnpayable(who);

        assertEq(usdc.balanceOf(who) - held, expected, "paid");
        assertEq(vault.unpayable(who), balance - expected, "the balance falls by what was paid");
        assertEq(vault.totalUnpayable(), total - expected, "and so does the total");
        assertEq(vault.payoutAllowance(), allowance - expected, "the allowance falls by what was paid");
        assertEq(vault.surplus(), surplusBefore, "surplus does not move");
    }

    /// @dev What the reserve can release now, read as the vault reads it: idle USDC plus the
    ///      smaller of its aUSDC and Aave's virtual balance.
    function _liquidity() internal view returns (uint256) {
        uint256 supplied = aUsdc.balanceOf(address(vault));
        uint256 inAave = pool.getVirtualUnderlyingBalance(address(usdc));
        return usdc.balanceOf(address(vault)) + (supplied < inAave ? supplied : inAave);
    }

    /// @dev A balance several times the capacity is paid across windows, at most the allowance per
    ///      call, part of a window included. Nothing else spends the allowance, so it is paid in
    ///      full within ceil(B / capacity) windows: 39,980 takes the first window and three refills.
    function test_claimUnpayable_paysABalanceSeveralTimesTheCapacityAcrossWindows() public {
        _deposit(alice, 100_000e6);
        for (uint256 i = 1; i <= 4; i++) {
            _credit(mallory, 10_000e6, i);
        }
        _blacklist(mallory);
        assertEq(vault.drain(10), 0, "all four retired");
        vm.clearMockedCalls();

        uint256 balance = 4 * _net(10_000e6);
        assertEq(vault.unpayable(mallory), balance);
        assertEq(vault.totalUnpayable(), balance);

        _claimUnpayableExpecting(mallory, CAPACITY);
        vm.expectRevert(abi.encodeWithSelector(InsufficientPayoutAllowance.selector, balance - CAPACITY, 0));
        vault.claimUnpayable(mallory);

        vm.warp(T0 + 6 hours);
        _claimUnpayableExpecting(mallory, CAPACITY / 4); // a quarter of the window refills a quarter

        vm.warp(T0 + 1 days);
        _claimUnpayableExpecting(mallory, CAPACITY - CAPACITY / 4);

        vm.warp(T0 + 2 days);
        _claimUnpayableExpecting(mallory, CAPACITY);

        vm.warp(T0 + 3 days);
        _claimUnpayableExpecting(mallory, balance - 3 * CAPACITY);

        assertEq(vault.totalUnpayable(), 0);
        assertEq(usdc.balanceOf(mallory), 1_000_000e6 + balance, "every unit, to the recipient");
        assertEq(vault.payoutAllowance(), 4 * CAPACITY - balance, "nothing spent past what was paid");
        vm.expectRevert(abi.encodeWithSelector(NothingUnpayable.selector, mallory));
        vault.claimUnpayable(mallory);
        _assertSolvent();
    }

    /// @dev Short of liquidity, it pays what the reserve can release and leaves the rest owed. The
    ///      allowance pays for what left, not for the balance. The rest is paid once borrowers repay.
    function test_claimUnpayable_paysWhatTheReserveCanReleaseAndTheRestLater() public {
        _deposit(alice, 100_000e6);
        _credit(mallory, 6_000e6, 1);
        _blacklist(mallory);
        vault.drain(10);
        vm.clearMockedCalls();
        vm.prank(guardian);
        vault.setInvestPaused(false); // what the retirement withdrew goes back to Aave

        // Borrowers leave the reserve 2,000.
        uint256 borrowed = usdc.balanceOf(address(aUsdc)) - 2_000e6;
        vm.prank(borrower);
        pool.drainForBorrow(borrowed);
        assertEq(_liquidity(), 2_000e6);

        _claimUnpayableExpecting(mallory, 2_000e6);
        assertEq(vault.payoutAllowance(), CAPACITY - 2_000e6, "spent by what left");
        vm.expectRevert(abi.encodeWithSelector(InsufficientLiquidity.selector, _net(6_000e6) - 2_000e6, 0));
        vault.claimUnpayable(mallory);

        vm.prank(borrower);
        usdc.transfer(address(aUsdc), borrowed);
        _claimUnpayableExpecting(mallory, _net(6_000e6) - 2_000e6);
        assertEq(usdc.balanceOf(mallory), 1_000_000e6 + _net(6_000e6), "all of it, in two parts");
        _assertSolvent();
    }

    /// @dev The balance can grow between part payments: a recipient blocked again has new credits
    ///      retired into what is still owed. Each step keeps the books: what was paid and what is
    ///      still owed add up to what retired, and the total is the sum of the balances.
    function test_claimUnpayable_balanceAddedToBetweenPartialClaims() public {
        _deposit(alice, 200_000e6);
        _credit(mallory, 8_000e6, 1);
        _credit(bob, 6_000e6, 2);
        _blacklist(mallory);
        assertEq(vault.drain(10), _net(6_000e6), "mallory retired, bob paid");
        vm.clearMockedCalls();
        uint256 retired = _net(8_000e6);

        _claimUnpayableExpecting(mallory, CAPACITY - _net(6_000e6)); // what bob left of the window
        _assertRetiredBooks(retired);

        // Blocked again, she has two more credits retired into what is still owed. Each retires
        // once the refill covers it, as the allowance is checked before the transfer is tried, and
        // that refill then pays the same 1,000 off the merged balance.
        uint256 clock = T0;
        uint256[2] memory more = [uint256(1_000e6), 500e6];
        for (uint256 k; k < 2; k++) {
            _blacklist(mallory);
            _credit(mallory, more[k], 3 + k);
            clock += 2 hours + 24 minutes; // 1,000 of refill
            vm.warp(clock);
            assertEq(vault.drain(10), 0, "retired, not paid");
            retired += _net(more[k]);
            _assertRetiredBooks(retired);

            vm.clearMockedCalls();
            _claimUnpayableExpecting(mallory, 1_000e6);
            _assertRetiredBooks(retired);
        }

        clock += 1 days;
        vm.warp(clock);
        _claimUnpayableExpecting(mallory, retired - (usdc.balanceOf(mallory) - 1_000_000e6));
        _assertRetiredBooks(retired);
        assertEq(vault.unpayable(mallory), 0);
        assertEq(usdc.balanceOf(mallory) - 1_000_000e6, retired, "every unit retired, paid once");
        _assertSolvent();
    }

    /// @dev Mallory's credits all retired, so `claimUnpayable` is the only thing that paid her.
    function _assertRetiredBooks(uint256 retired) internal view {
        uint256 paid = usdc.balanceOf(mallory) - 1_000_000e6;
        assertEq(paid + vault.unpayable(mallory), retired, "paid and still owed add up to what retired");
        assertEq(vault.totalUnpayable(), vault.unpayable(mallory), "the total is the sum of the balances");
    }

    /// @dev It refuses only when nothing can be paid, in a fixed order: the pause, an empty
    ///      balance, a reserve that can release nothing, then a spent allowance. Liquidity is checked
    ///      before the allowance, so with neither it reports the liquidity. Each error reports the
    ///      whole balance as requested.
    function test_claimUnpayable_revertsOnlyWhenNothingCanBePaid() public {
        _deposit(alice, 100_000e6);
        _credit(mallory, 6_000e6, 1);
        _blacklist(mallory);
        vault.drain(10);
        vm.clearMockedCalls();
        vm.prank(guardian);
        vault.setInvestPaused(false); // what the retirement withdrew goes back to Aave
        uint256 balance = _net(6_000e6);

        vm.expectRevert(abi.encodeWithSelector(NothingUnpayable.selector, bob));
        vault.claimUnpayable(bob);

        // No liquidity, the whole allowance.
        uint256 borrowed = usdc.balanceOf(address(aUsdc));
        vm.prank(borrower);
        pool.drainForBorrow(borrowed);
        assertEq(_liquidity(), 0);
        assertEq(vault.payoutAllowance(), CAPACITY);
        vm.expectRevert(abi.encodeWithSelector(InsufficientLiquidity.selector, balance, 0));
        vault.claimUnpayable(mallory);

        // Neither: the liquidity is reported, and an empty balance before either.
        vm.prank(admin);
        vault.setPayoutLimit(0, 0);
        vm.expectRevert(abi.encodeWithSelector(InsufficientLiquidity.selector, balance, 0));
        vault.claimUnpayable(mallory);
        vm.expectRevert(abi.encodeWithSelector(NothingUnpayable.selector, bob));
        vault.claimUnpayable(bob);

        // Liquidity back, no allowance.
        vm.prank(borrower);
        usdc.transfer(address(aUsdc), borrowed);
        vm.expectRevert(abi.encodeWithSelector(InsufficientPayoutAllowance.selector, balance, 0));
        vault.claimUnpayable(mallory);

        // The pause comes before everything.
        vm.prank(guardian);
        vault.setClaimsPaused(true);
        vm.expectRevert(ClaimsPaused.selector);
        vault.claimUnpayable(mallory);
        vm.expectRevert(ClaimsPaused.selector);
        vault.claimUnpayable(bob);
        vm.prank(guardian);
        vault.setClaimsPaused(false);

        assertEq(vault.unpayable(mallory), balance, "nothing refused moved the books");
        assertEq(vault.totalUnpayable(), balance);

        // Reopened, the limit starts empty, and pays once it has refilled.
        vm.prank(admin);
        vault.setPayoutLimit(CAPACITY, WINDOW);
        vm.warp(T0 + WINDOW);
        _claimUnpayableExpecting(mallory, balance);
    }

    // Fuzz bookkeeping. Every run starts from the state `setUp` leaves, these included.
    address[2] internal fzWho;
    mapping(address => bool) internal fzListed;
    mapping(address => uint256) internal fzRetired;
    mapping(address => uint256) internal fzPaid;
    mapping(address => uint256) internal fzEmitted;
    uint256[] internal fzClock;
    uint256[] internal fzOut;
    uint256 internal fzBorrowed;

    /// @dev Over arbitrary mixes of retirements, additions to a balance, part payments, queue
    ///      payments competing for the allowance, liquidity coming and going, and waiting:
    ///      - every unit retired is paid once or still owed, and the event reports what was paid;
    ///      - `totalUnpayable` is the sum of the balances;
    ///      - a claim pays the smallest of balance, liquidity and allowance, and is refused only
    ///        when its recipient is blocked or that smallest is zero;
    ///      - over any span, nothing is paid past the capacity plus the refill over that span.
    ///      Then, with every block lifted and nothing else spending, every balance is paid within
    ///      ceil(B / capacity) windows.
    function testFuzz_claimUnpayable_partialClaimsPayEveryRetiredUnitOnce(uint256 seed) public {
        _deposit(alice, 300_000e6);
        fzWho[0] = carol;
        fzWho[1] = dave;
        _fzSetListed(carol, true);
        _fzSetListed(dave, true);
        uint256 clock = T0;
        _fzCheckpoint(clock);

        for (uint256 i = 1; i <= 40; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address who = fzWho[(seed >> 8) % 2];
            uint256 op = seed % 10;

            if (op < 2) {
                _credit(who, bound(seed >> 16, 1e6, 6_000e6), i);
            } else if (op == 2) {
                _credit(bob, bound(seed >> 16, 1e6, 6_000e6), i);
            } else if (op < 5) {
                _fzDrain(1 + (seed >> 80) % 5);
            } else if (op < 7) {
                _fzClaimUnpayable(who);
            } else if (op == 7) {
                _fzSetListed(who, !fzListed[who]);
            } else if (op == 8) {
                clock += (seed >> 96) % 12 hours;
                vm.warp(clock);
            } else {
                _fzMoveLiquidity(seed >> 112);
            }

            _fzCheckpoint(clock);
            _fzAssertBooks();
        }

        _fzSettleUp(clock);
    }

    /// @dev Drains, and books what it retired from the vault's own `CreditUnpayable` events.
    function _fzDrain(uint256 maxEntries) internal {
        vm.recordLogs();
        vault.drain(maxEntries);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 j; j < logs.length; j++) {
            if (logs[j].emitter == address(vault) && logs[j].topics[0] == CreditUnpayable.selector) {
                fzRetired[address(uint160(uint256(logs[j].topics[2])))] += abi.decode(logs[j].data, (uint256));
            }
        }
    }

    /// @dev Claims for `who`, and checks the call against the smallest of balance, liquidity and
    ///      allowance read just before it. Books what reached them and what the event said.
    function _fzClaimUnpayable(address who) internal {
        uint256 expected = vault.unpayable(who);
        uint256 liquidity = _liquidity();
        uint256 allowance = vault.payoutAllowance();
        if (liquidity < expected) expected = liquidity;
        if (allowance < expected) expected = allowance;
        uint256 held = usdc.balanceOf(who);

        vm.recordLogs();
        try vault.claimUnpayable(who) {
            assertFalse(fzListed[who], "a blocked recipient is never paid");
            assertEq(usdc.balanceOf(who) - held, expected, "pays the smallest of balance, liquidity and allowance");
        } catch {
            assertTrue(fzListed[who] || expected == 0, "refused only when nothing could be paid");
        }
        fzPaid[who] += usdc.balanceOf(who) - held;

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 j; j < logs.length; j++) {
            if (
                logs[j].emitter == address(vault) && logs[j].topics[0] == UnpayableClaimed.selector
                    && address(uint160(uint256(logs[j].topics[1]))) == who
            ) fzEmitted[who] += abi.decode(logs[j].data, (uint256));
        }
    }

    /// @dev Circle blocks or clears `who`. The mocks are rebuilt, since clearing them clears all.
    function _fzSetListed(address who, bool listed) internal {
        fzListed[who] = listed;
        vm.clearMockedCalls();
        for (uint256 j; j < 2; j++) {
            if (fzListed[fzWho[j]]) _blacklist(fzWho[j]);
        }
    }

    /// @dev Liquidity comes and goes. A retirement leaves its amount idle in the vault, where it
    ///      stays until a deposit sweeps it back into Aave, so a deposit is one move here. Borrowers
    ///      take Aave down to a few thousand, or repay part of what they took.
    function _fzMoveLiquidity(uint256 r) internal {
        uint256 move = r % 3;
        if (move == 0) {
            _deposit(alice, bound(r >> 8, 1e6, 6_000e6));
        } else if (move == 1) {
            uint256 held = usdc.balanceOf(address(aUsdc));
            uint256 left = bound(r >> 8, 0, 12_000e6);
            uint256 amount = held > left ? held - left : 0;
            vm.prank(borrower);
            pool.drainForBorrow(amount);
            fzBorrowed += amount;
        } else {
            uint256 amount = bound(r >> 8, 0, fzBorrowed);
            vm.prank(borrower);
            usdc.transfer(address(aUsdc), amount);
            fzBorrowed -= amount;
        }
    }

    /// @dev Everything paid against credits, cumulative: bob and the two retirable recipients are
    ///      the only payees, and none of them holds USDC from anywhere else.
    function _fzCheckpoint(uint256 clock) internal {
        fzClock.push(clock);
        fzOut.push(usdc.balanceOf(bob) + usdc.balanceOf(fzWho[0]) + usdc.balanceOf(fzWho[1]));
    }

    function _fzAssertBooks() internal view {
        uint256 sum;
        for (uint256 j; j < 2; j++) {
            address who = fzWho[j];
            uint256 owedNow = vault.unpayable(who);
            assertEq(fzPaid[who] + owedNow, fzRetired[who], "every unit retired is paid once or still owed");
            assertEq(fzEmitted[who], fzPaid[who], "the event reports what was paid");
            sum += owedNow;
        }
        assertEq(vault.totalUnpayable(), sum, "the total is the sum of the balances");

        // Over the span from any earlier checkpoint to this one. The refill is floored at each
        // update, so a span that starts between updates can see one unit more.
        uint256 last = fzClock.length - 1;
        for (uint256 k; k < last; k++) {
            assertLe(
                fzOut[last] - fzOut[k],
                CAPACITY + (CAPACITY * (fzClock[last] - fzClock[k])) / WINDOW + 1,
                "paid past the limit over a span"
            );
        }
        _assertSolvent();
    }

    /// @dev Lift every block, repay the borrowers, and spend nothing else. One call per recipient
    ///      each window then pays every balance within ceil(B / capacity) windows.
    function _fzSettleUp(uint256 clock) internal {
        _fzSetListed(fzWho[0], false);
        _fzSetListed(fzWho[1], false);
        vm.prank(borrower);
        usdc.transfer(address(aUsdc), fzBorrowed);
        fzBorrowed = 0;

        uint256 owedAtStart = vault.totalUnpayable();
        uint256 windows;
        while (true) {
            for (uint256 j; j < 2; j++) {
                if (vault.unpayable(fzWho[j]) > 0) _fzClaimUnpayable(fzWho[j]);
            }
            _fzCheckpoint(clock);
            _fzAssertBooks();
            if (vault.totalUnpayable() == 0) break;

            clock += WINDOW;
            vm.warp(clock);
            windows++;
        }

        assertLe(windows, (owedAtStart + CAPACITY - 1) / CAPACITY, "paid within ceil(B / capacity) windows");
        for (uint256 j; j < 2; j++) {
            assertEq(fzPaid[fzWho[j]], fzRetired[fzWho[j]], "every unit retired, paid");
        }
    }
}
