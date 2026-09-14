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
    MockWormholeCore,
    VaaBuilder
} from "../mocks/PsmMocks.sol";

/// @notice Regression: the queue moves only at the head. `cancelQueuedRedemption` retires the head
///         and nothing else, so no slot is ever zeroed behind the head — the same discipline
///         BasejumpLanding's pending queue keeps. Without it, cancelling from the middle left holes
///         that every later head advance had to walk in one unbounded loop, and enough of them cost
///         more gas than a block carries.
abstract contract QueueFixture is Test, IHollarBaseVault {
    HollarBaseVault internal vault;
    MockToken internal usdc;
    MockAToken internal aUsdc;
    MockAavePool internal pool;
    MockWormholeCore internal wormhole;

    uint16 internal constant BASE_CHAIN = 30;
    uint16 internal constant HYDRATION_CHAIN = 73;
    bytes32 internal constant HYDRATION_EMITTER = bytes32(uint256(0x4bd7a));
    uint256 internal constant MIN_PRICE = 99e6;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal treasurer = makeAddr("treasurer");
    address internal alice = makeAddr("alice");
    address internal mallory = makeAddr("mallory");

    uint256 internal victim;

    /// how many cancellable dust slots to sit between the head and the victim
    function deadSlots() internal pure virtual returns (uint256);

    function setUp() public {
        vm.pauseGasMetering(); // building the fixture is not what we measure

        vm.warp(365 days);
        wormhole = new MockWormholeCore(BASE_CHAIN, 0);
        usdc = new MockToken("USDC", 6);
        aUsdc = new MockAToken();
        pool = new MockAavePool(usdc, aUsdc);
        MockAggregator agg = new MockAggregator(1e8);
        MockAddressesProvider provider =
            new MockAddressesProvider(address(pool), address(new MockAaveOracle(address(new MockCappedAdapter(agg)), agg)));

        vault = HollarBaseVault(
            address(
                new ERC1967Proxy(
                    address(new HollarBaseVault()),
                    abi.encodeCall(
                        HollarBaseVault.initializeVault,
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
        );

        vm.startPrank(admin);
        vault.setHydrationEmitter(HYDRATION_EMITTER);
        vault.setDepositLimit(RateLimiter.UNLIMITED, 0);
        vm.stopPrank();
        vm.prank(guardian);
        vault.setDepositsPaused(false);

        usdc.mint(alice, 10_000_000e6);
        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(1_000_000e6, PsmPayload.fromAddress(alice));
        vm.stopPrank();

        uint256 n = deadSlots();

        // slot 0: mallory's own live credit. Pins the head so nothing can advance.
        vault.receiveMessage(_vaa(mallory, 1e6, 0));

        // slots 1..n: dust redeems — what an attacker would try to turn into a graveyard.
        for (uint256 i = 1; i <= n; i++) {
            vault.receiveMessage(_vaa(mallory, 1, i));
        }

        // slot n+1: a real user, queued behind them.
        victim = n + 1;
        vault.receiveMessage(_vaa(alice, 50_000e6, type(uint256).max));

        vm.resumeGasMetering();
    }

    function _vaa(address to, uint256 amount, uint256 salt) internal pure returns (bytes memory) {
        return VaaBuilder.buildSalted(
            HYDRATION_CHAIN,
            HYDRATION_EMITTER,
            PsmPayload.encode(PsmPayload.KIND_REDEEM, PsmPayload.fromAddress(to), amount, PsmPayload.fromAddress(to)),
            salt
        );
    }
}

contract QueueHeadOnlyTest is QueueFixture {
    function deadSlots() internal pure override returns (uint256) {
        return 3;
    }

    function test_cancelFromTheMiddleIsRefused() public {
        // Every slot behind the head is someone's live credit and mallory owns three of them.
        // Ownership is not enough: the head is mallory's too, so the refusal is about position.
        for (uint256 i = 1; i <= deadSlots(); i++) {
            vm.prank(mallory);
            vm.expectRevert(abi.encodeWithSelector(CancelNotAtHead.selector, i, 0));
            vault.cancelQueuedRedemption(i);
        }

        assertEq(vault.queueHead(), 0, "head unmoved");
        assertEq(vault.queueLength(), deadSlots() + 2, "nothing left the queue");
    }

    function test_cancelAtTheHeadMovesItByOne() public {
        vault.drain(1); // pay slot 0, head lands on mallory's first dust credit

        for (uint256 i = 1; i <= deadSlots(); i++) {
            assertEq(vault.queueHead(), i, "cancels advance the head one slot at a time");
            vm.prank(mallory);
            vault.cancelQueuedRedemption(i);
        }

        // The victim is the head now, reached without a walk: every cancel moved the head itself.
        assertEq(vault.queueHead(), victim);
        (address next,) = vault.queueHeadEntry();
        assertEq(next, alice);

        vault.drain(1);
        assertEq(vault.owed(alice), 0, "victim paid");
    }

    function test_queueLengthCountsOnlyLiveEntries() public {
        vault.drain(1);
        vm.prank(mallory);
        vault.cancelQueuedRedemption(1);

        // Was wrong while holes existed — tail minus head counted them.
        assertEq(vault.queueLength(), deadSlots() + 2 - 2);
        (bool found,, uint256 position) = vault.queueEntryOf(alice);
        assertTrue(found);
        assertEq(position, deadSlots() - 1, "position is the real distance to the head");
    }
}

contract QueueCostIsFlatTest is QueueFixture {
    uint256 internal constant N = 1_500;

    function deadSlots() internal pure override returns (uint256) {
        return N;
    }

    /// The old shape charged one cold SLOAD per retired slot to whoever crossed them, all in one
    /// call. Nothing crosses anything now, so depth is not something a later caller pays for.
    function test_crossingIsNotLinearInRetiredSlots() public {
        vault.drain(1);

        vm.startPrank(mallory);
        uint256 before = gasleft();
        vault.cancelQueuedRedemption(1);
        uint256 firstCancel = before - gasleft();

        for (uint256 i = 2; i < N; i++) {
            vault.cancelQueuedRedemption(i);
        }

        before = gasleft();
        vault.cancelQueuedRedemption(N);
        uint256 lastCancel = before - gasleft();
        vm.stopPrank();

        // The victim is the head with N retired slots behind it. This is the call that used to OOG.
        before = gasleft();
        vault.drain(1);
        uint256 reachVictim = before - gasleft();

        emit log_named_uint("retired slots behind the head", N);
        emit log_named_uint("gas: first cancel", firstCancel);
        emit log_named_uint("gas: last cancel", lastCancel);
        emit log_named_uint("gas: drain(1) reaching the victim", reachVictim);

        assertLt(lastCancel, firstCancel + 5_000, "cancel does not get more expensive with depth");
        assertLt(reachVictim, 300_000, "reaching the victim is one entry's work, not N");
        assertEq(vault.owed(alice), 0, "victim paid");
    }
}
