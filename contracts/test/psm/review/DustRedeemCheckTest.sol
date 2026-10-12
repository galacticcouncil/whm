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

/// @title Verification of the external review's "dust redemption strands HOLLAR" claim.
/// @notice Claim: the vault reverts ZeroAmount for dust redeems (fee rounds to zero below
///         ~$0.0002) and the burned HOLLAR is unrecoverable. The math says otherwise:
///         credited = amount - floor(amount * 5 / 10000) == 0 only when amount == 0,
///         and a zero redeem burns nothing.
contract DustRedeemCheckTest is Test, IHollarBaseVault {
    HollarBaseVault internal vault;
    HollarBaseFacilitator internal facilitator;
    MockToken internal usdc;
    MockAToken internal aUsdc;
    MockAavePool internal pool;
    MockGho internal hollar;
    MockWormholeCore internal wormholeBase;
    MockWormholeCore internal wormholeHydra;

    uint16 internal constant BASE_CHAIN = 30;
    uint16 internal constant HYDRATION_CHAIN = 73;
    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal treasurer = makeAddr("treasurer");
    address internal alice = makeAddr("alice");

    function setUp() public {
        vm.warp(365 days);
        wormholeBase = new MockWormholeCore(BASE_CHAIN, 0);
        wormholeHydra = new MockWormholeCore(HYDRATION_CHAIN, 0);
        usdc = new MockToken("USDC", 6);
        aUsdc = new MockAToken();
        pool = new MockAavePool(usdc, aUsdc);
        MockAggregator aggregator = new MockAggregator(1e8);
        MockCappedAdapter cappedAdapter = new MockCappedAdapter(aggregator);
        MockAddressesProvider provider = new MockAddressesProvider(
            address(pool), address(new MockAaveOracle(address(cappedAdapter), aggregator))
        );
        hollar = new MockGho();

        vault = HollarBaseVault(
            address(
                new ERC1967Proxy(
                    address(new HollarBaseVault()),
                    abi.encodeCall(
                        HollarBaseVault.initializeVault,
                        (
                            VaultInit({
                                wormhole: address(wormholeBase),
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
                        (address(wormholeHydra), address(hollar), 6, BASE_CHAIN, admin, guardian)
                    )
                )
            )
        );

        hollar.addFacilitator(address(facilitator), 1_000_000e18);
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

        usdc.mint(alice, 1_000_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _relayHydraToBase(uint256 salt) internal {
        bytes memory payload = wormholeHydra.lastPublished().payload;
        vault.receiveMessage(
            VaaBuilder.buildSalted(HYDRATION_CHAIN, PsmPayload.fromAddress(address(facilitator)), payload, salt)
        );
    }

    /// @dev The claim's dust range: amount in [1, 1999] has fee == 0 but credited == amount > 0,
    ///      so the credit books fine and no HOLLAR is stranded.
    function testFuzz_dustRedeem_booksAndPays(uint16 amount) public {
        vm.assume(amount > 0 && amount < 2000);

        vm.prank(alice);
        vault.deposit(10_000e6, PsmPayload.fromAddress(alice));
        facilitator.receiveMessage(
            VaaBuilder.buildSalted(BASE_CHAIN, PsmPayload.fromAddress(address(vault)), wormholeBase.lastPublished().payload, 1)
        );

        vm.startPrank(alice);
        hollar.approve(address(facilitator), type(uint256).max);
        facilitator.redeem(amount, alice);
        vm.stopPrank();

        _relayHydraToBase(2);
        assertEq(vault.owed(alice), amount, "dust credit books in full (fee rounds to zero)");

        vm.prank(alice);
        vault.claim();
        assertEq(usdc.balanceOf(alice), 1_000_000e6 - 10_000e6 + amount, "dust redeem pays out");
    }

    /// @dev Only amount == 0 reverts on the vault, and it burns nothing: the "stranded HOLLAR"
    ///      scenario does not exist. The residue is an unconsumable VAA costing one message fee.
    function test_zeroRedeem_burnsNothing_vaultRejects() public {
        vm.prank(alice);
        vault.deposit(100e6, PsmPayload.fromAddress(alice));
        facilitator.receiveMessage(
            VaaBuilder.buildSalted(BASE_CHAIN, PsmPayload.fromAddress(address(vault)), wormholeBase.lastPublished().payload, 1)
        );

        uint256 before = hollar.balanceOf(alice);
        vm.startPrank(alice);
        hollar.approve(address(facilitator), type(uint256).max);
        facilitator.redeem(0, alice);
        vm.stopPrank();
        assertEq(hollar.balanceOf(alice), before, "zero redeem burns zero HOLLAR");

        bytes memory payload = wormholeHydra.lastPublished().payload;
        bytes memory vaa =
            VaaBuilder.buildSalted(HYDRATION_CHAIN, PsmPayload.fromAddress(address(facilitator)), payload, 2);
        vm.expectRevert(ZeroAmount.selector);
        vault.receiveMessage(vaa);
    }
}
