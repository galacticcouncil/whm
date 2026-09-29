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

/// @title Verification of the external review's item 4: drain unwinds already-payable entries
/// @notice Claim: when a later entry's Aave sourcing reverts, the whole drain reverts, including
///         earlier entries that were payable from idle USDC. The guard's `_reserveLiquidity`
///         counts Aave's virtual balance as available even when withdrawals revert (reserve pause).
contract DrainAtomicUnwindTest is Test, IHollarBaseVault {
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
    address internal bob = makeAddr("bob");

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

        vault = HollarBaseVault(
            address(
                new ERC1967Proxy(
                    address(new HollarBaseVault()),
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

    function test_drain_unwindsIdlePayableHeadWhenLaterAaveSourcingReverts() public {
        vm.prank(alice);
        vault.deposit(200_000e6, PsmPayload.fromAddress(alice)); // all invested; idle = 0

        // Two credits: head small (payable from idle), second large (needs Aave).
        vault.receiveMessage(_redeemVaaSalted(bob, 10_000e6, 1)); // net 9_995e6
        vault.receiveMessage(_redeemVaaSalted(alice, 100_000e6, 2)); // net 99_950e6

        // Give the vault 10_000e6 of idle USDC via the guardian unwind.
        vm.prank(guardian);
        vault.emergencyUnwindAave(10_000e6);

        // Aave now refuses withdrawals (reserve pause) while getVirtualUnderlyingBalance
        // still reports plenty — the drain guard sees the second entry as payable.
        pool.setWithdrawReverts(true);
        assertGt(vault.claimable(bob), 0, "head payable from idle");

        // drain(2) reverts wholly: the head's payment is rolled back too.
        vm.expectRevert("WITHDRAW_PAUSED");
        vault.drain(2);
        assertEq(vault.queueHead(), 0, "nothing settled - the idle-payable head was unwound");
        assertEq(usdc.balanceOf(bob), 0, "bob not paid");

        // Single-entry drain of the idle-payable head succeeds without touching Aave.
        assertEq(vault.drain(1), 9_995e6, "head pays from idle alone");
        assertEq(usdc.balanceOf(bob), 9_995e6);
        assertEq(vault.queueHead(), 1);
    }
}
