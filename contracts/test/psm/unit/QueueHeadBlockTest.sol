// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {HollarBaseVault} from "../../../src/psm/HollarBaseVault.sol";
import {IHollarBaseVault} from "../../../src/psm/interfaces/IHollarBaseVault.sol";
import {PsmPayload} from "../../../src/psm/lib/PsmPayload.sol";
import {RateLimiter} from "../../../src/psm/lib/RateLimiter.sol";
import {
    MockAToken, MockAaveOracle, MockAavePool, MockAddressesProvider, MockAggregator,
    MockCappedAdapter, MockToken, MockWormholeCore
} from "../mocks/PsmMocks.sol";

contract QueueHeadBlockTest is Test, IHollarBaseVault {
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
    uint256 internal constant ONE_USD = 1e8;
    uint256 internal constant MIN_PRICE = 99e6;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal treasurer = makeAddr("treasurer");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");
    address internal borrower = makeAddr("borrower");

    function setUp() public {
        vm.warp(365 days);
        wormhole = new MockWormholeCore(BASE_CHAIN, 0);
        usdc = new MockToken("USDC", 6);
        aUsdc = new MockAToken();
        pool = new MockAavePool(usdc, aUsdc);
        aggregator = new MockAggregator(int256(ONE_USD));
        cappedAdapter = new MockCappedAdapter(aggregator);
        provider = new MockAddressesProvider(address(pool), address(new MockAaveOracle(address(cappedAdapter), aggregator)));

        HollarBaseVault impl = new HollarBaseVault();
        vault = HollarBaseVault(address(new ERC1967Proxy(address(impl), abi.encodeCall(HollarBaseVault.initializeVault, (
            VaultInit({
                wormhole: address(wormhole), usdc: address(usdc), aUsdc: address(aUsdc),
                addressesProvider: address(provider), hydrationChainId: HYDRATION_CHAIN,
                minUsdcPrice: MIN_PRICE, admin: admin, guardian: guardian, treasurer: treasurer
            }))))));

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

    function _vaa(address recipient, uint256 amount, uint256 salt) internal pure returns (bytes memory) {
        return abi.encode(HYDRATION_CHAIN, HYDRATION_EMITTER,
            PsmPayload.encode(PsmPayload.KIND_REDEEM, PsmPayload.fromAddress(recipient), amount), salt);
    }

    /// USDC on Base is blacklistable. Emulate Circle blacklisting `mallory` — every
    /// usdc.transfer(mallory, ...) reverts from then on.
    function _blacklist(address who) internal {
        vm.mockCallRevert(address(usdc), abi.encodeWithSelector(MockToken.transfer.selector, who), "Blacklistable: account is blacklisted");
    }

    /// The bug this file was written for: a recipient USDC cannot reach used to sit at the head
    /// forever, because the transfer that failed was in the same frame that advances `queueHead`.
    function test_blacklistedHeadRetiresAndQueueMovesOn() public {
        vm.prank(alice);
        vault.deposit(100_000e6, PsmPayload.fromAddress(alice));

        // Attacker redeems the minimum on Hydration naming a known Circle-blacklisted address.
        vault.receiveMessage(_vaa(mallory, 10e6, 1));
        // An ordinary user queues behind.
        vault.receiveMessage(_vaa(alice, 5_000e6, 2));

        (address head,) = vault.queueHeadEntry();
        assertEq(head, mallory, "attacker owns the head");

        _blacklist(mallory);

        uint256 malloryCredit = 10e6 - (10e6 * 5) / 10_000;
        uint256 aliceCredit = 5_000e6 - (5_000e6 * 5) / 10_000;

        // Permissionless drain retires the unpayable head and pays everyone behind it.
        vm.expectEmit(true, true, false, true, address(vault));
        emit CreditUnpayable(0, mallory, malloryCredit);
        uint256 paid = vault.drain(10);

        assertEq(paid, aliceCredit, "drain reports only what actually moved");
        assertEq(usdc.balanceOf(alice), 900_000e6 + aliceCredit, "alice is paid in full");
        assertEq(vault.queueLength(), 0, "queue drained");
        assertEq(vault.owed(mallory), 0, "no longer queued");

        // Still owed, and still a liability -- not quietly converted into sweepable profit.
        assertEq(vault.unpayable(mallory), malloryCredit, "retired, not discharged");
        assertEq(vault.totalUnpayable(), malloryCredit);

        // While still blacklisted, paying out reverts and costs the caller nothing but gas.
        vm.expectRevert("Blacklistable: account is blacklisted");
        vault.claimUnpayable(mallory);

        // Once Circle clears them, anyone can push their money to them -- and only to them.
        vm.clearMockedCalls();
        vault.claimUnpayable(mallory);
        assertEq(usdc.balanceOf(mallory), malloryCredit, "paid after the block clears");
        assertEq(vault.totalUnpayable(), 0);
    }

    /// The two exits are complementary. A recipient USDC cannot reach is retired by anyone via
    /// `drain`; if that recipient is the redeemer themselves, they can instead take the HOLLAR back.
    function test_blacklistedRedeemerCanCancelInsteadOfBeingRetired() public {

        vm.prank(alice);
        vault.deposit(100_000e6, PsmPayload.fromAddress(alice));
        vault.receiveMessage(_vaa(alice, 10_000e6, 1));

        // Circle blacklists alice after she redeemed but before she was paid.
        _blacklist(alice);

        (bool found, uint256 index,) = vault.queueEntryOf(alice);
        assertTrue(found, "her credit is queued");
        uint256 principalBefore = vault.principal();

        vm.prank(alice);
        vault.cancelQueuedRedemption(index);

        assertEq(vault.owed(alice), 0, "no longer owed USDC");
        assertEq(vault.unpayable(alice), 0, "and never had to be retired");
        assertEq(vault.principal(), principalBefore + 10_000e6, "gross returns to backing");
        assertEq(vault.queueLength(), 0, "the queue is clear");

        (uint8 kind,, uint256 amount) = PsmPayload.decode(wormhole.lastPublished().payload);
        assertEq(kind, PsmPayload.KIND_MINT);
        assertEq(amount, 10_000e6, "gross re-minted, so the fee is not charged for nothing");
    }

    /// Only the credit's own recipient may cancel it.
    function test_cancelIsRecipientOnly() public {

        vm.prank(alice);
        vault.deposit(100_000e6, PsmPayload.fromAddress(alice));
        vault.receiveMessage(_vaa(alice, 10_000e6, 1));

        (, uint256 index,) = vault.queueEntryOf(alice);

        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(NotYourCredit.selector, index, alice));
        vault.cancelQueuedRedemption(index);

        vm.prank(alice);
        vault.cancelQueuedRedemption(index);

        // And a cancelled slot cannot be cancelled twice.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NotQueued.selector, index));
        vault.cancelQueuedRedemption(index);
    }

    /// Aave v3.3 charges withdrawals against `virtualUnderlyingBalance`, not the aToken's raw
    /// holding. Donations to the aToken sit in the gap -- 230.7 USDC on Base today -- and sizing a
    /// payout by the raw balance asks Aave for more than it will release.
    /// Sized so the credit sits ABOVE Aave's virtual balance but BELOW the donation-inflated
    /// figure: reading the aToken's raw holding makes the vault believe it can pay, and Aave then
    /// refuses the withdrawal and reverts the entire call.
    function test_reserveLiquidityIgnoresDonationsToTheAToken() public {

        vm.prank(alice);
        vault.deposit(100_000e6, PsmPayload.fromAddress(alice));

        // Anyone can widen the gap; the donation is never withdrawable. This is the live Base figure.
        pool.donate(230_717019);

        vault.receiveMessage(_vaa(alice, 10_000e6, 1));
        uint256 credit = 10_000e6 - (10_000e6 * 5) / 10_000;

        // Leave Aave holding 9,900 real + the 230.717019 donation. The borrow amount is computed
        // first: a call in the argument list would consume the prank before drainForBorrow sees it.
        uint256 borrowed = usdc.balanceOf(address(aUsdc)) - 230_717019 - 9_900e6;
        vm.prank(borrower);
        pool.drainForBorrow(borrowed);

        assertLt(9_900e6, credit, "virtual is short of the credit");
        assertGt(9_900e6 + 230_717019, credit, "but the raw aToken balance is not");

        // Sized off virtual, nothing is payable -- and nothing reverts.
        assertEq(vault.claimable(alice), 0, "not payable, so not promised");
        assertEq(vault.drain(5), 0, "and drain is a no-op rather than a revert");
        assertEq(vault.owed(alice), credit, "the credit is intact");

        // Borrowers repay; it settles in full.
        vm.prank(borrower);
        usdc.transfer(address(aUsdc), 50_000e6);
        assertEq(vault.claimable(alice), credit, "payable in full once liquidity returns");
        assertEq(vault.drain(5), credit, "and paid");
    }

    /// Retiring a credit must not put the RECIPIENT'S money within reach of the treasurer. It
    /// moves their net from `totalOwed` to `totalUnpayable`, and `surplus()` must keep counting
    /// it — otherwise the treasurer sweeps a blacklisted recipient's money out of the reserve.
    ///
    /// The fee is the one part released, and only because retiring is terminal: `_settle` has
    /// zeroed the queue slot, so there is no `cancelQueuedRedemption` path back. That earns it.
    function test_retiredCreditStaysALiabilityAndIsNotSweepable() public {

        vm.prank(alice);
        vault.deposit(100_000e6, PsmPayload.fromAddress(alice));

        vault.receiveMessage(_vaa(mallory, 10_000e6, 1));
        uint256 fee = (10_000e6 * 5) / 10_000;
        uint256 credit = 10_000e6 - fee;

        uint256 surplusWhileQueued = vault.surplus();
        uint256 sweepableWhileQueued = vault.sweepable();
        assertEq(vault.totalOwed(), 10_000e6, "queued at the gross, fee not yet earned");

        _blacklist(mallory);
        vault.drain(10);

        assertEq(vault.totalUnpayable(), credit, "retired at the net the recipient is still owed");
        assertEq(vault.totalOwed(), 0, "and no longer queued");

        // The recipient's money only changed shelf; only the fee is released.
        assertEq(vault.surplus(), surplusWhileQueued + fee, "the fee, and nothing more");
        // The released fee is not sweepable either — the surplus floor, sized off `principal`,
        // still sits well above it.
        assertEq(vault.sweepable(), sweepableWhileQueued, "the floor absorbs the released fee");

        // And the treasurer cannot reach it.
        uint256 limit = vault.sweepable();
        vm.prank(treasurer);
        vm.expectRevert(abi.encodeWithSelector(SurplusBelowFloor.selector, limit + credit, limit));
        vault.sweepSurplus(limit + credit, treasurer);
    }
}
