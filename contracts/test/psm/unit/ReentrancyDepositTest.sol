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
    MockReentrantToken,
    MockWormholeCore
} from "../mocks/PsmMocks.sol";

/// @title Reentrancy cannot inflate what `deposit` attests
/// @notice Adversarial-review finding on xchain#55's delta fix: reading the vault's own balance
///         across `transferFrom` is only trustworthy if nothing else can move that balance inside
///         the bracket. A token whose `transferFrom` calls back into a second `deposit` — landing
///         real funds in the vault before the outer frame's own transfer completes, with Aave
///         refusing the inner frame's supply so those funds sit idle — lets the outer frame's
///         balance read absorb funds the inner frame already booked, unless the observed delta is
///         capped at what the outer frame itself asked to move.
contract ReentrancyDepositTest is Test, IHollarBaseVault {
    HollarBaseVault internal vault;
    MockReentrantToken internal usdc;
    MockAToken internal aUsdc;
    MockAavePool internal pool;
    MockWormholeCore internal wormhole;

    uint16 internal constant HYDRATION_CHAIN = 73;
    bytes32 internal constant HYDRATION_EMITTER = bytes32(uint256(0x4bd7a));
    uint256 internal constant MIN_PRICE = 99e6;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal treasurer = makeAddr("treasurer");
    address internal alice = makeAddr("alice");

    function setUp() public {
        wormhole = new MockWormholeCore(30, 0);
        usdc = new MockReentrantToken();
        aUsdc = new MockAToken();
        pool = new MockAavePool(usdc, aUsdc);
        MockAggregator aggregator = new MockAggregator(int256(1e8));
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

        // Aave refuses every supply — the condition the PoC needs: the nested frame's funds sit
        // idle as USDC instead of moving into aUSDC before the outer frame reads its own delta.
        pool.setSupplyReverts(true);

        usdc.mint(alice, 1_000_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
    }

    /// @dev Regression: nesting a second `deposit` inside the first's `transferFrom` must not let
    ///      the outer frame's balance read book funds the inner frame already accounted for. The
    ///      reserve holds exactly what both deposits actually transferred; `principal` and the
    ///      published mint total must match that, never overcount by the inner deposit's amount.
    function test_deposit_reentrancyCannotInflateAttestedTotal() public {
        address innerRecipient = makeAddr("innerRecipient");
        address outerRecipient = makeAddr("outerRecipient");
        uint256 innerAmount = 100_000e6;
        uint256 outerAmount = 100_000e6;

        // The token itself stands in for whatever account the attacker controls on the other
        // side of the callback: funded and self-approved so the nested transferFrom can move
        // real value into the vault before the outer transfer completes.
        usdc.mint(address(usdc), innerAmount);
        usdc.selfApprove(address(vault));

        usdc.armReentry(
            address(vault),
            abi.encodeCall(HollarBaseVault.deposit, (innerAmount, PsmPayload.fromAddress(innerRecipient)))
        );

        vm.prank(alice);
        vault.deposit(outerAmount, PsmPayload.fromAddress(outerRecipient));

        uint256 held = usdc.balanceOf(address(vault)) + aUsdc.balanceOf(address(vault));
        assertEq(held, innerAmount + outerAmount, "sanity: both transfers actually landed");

        assertEq(vault.principal(), held, "attested principal must not exceed what the reserve holds");

        (,, uint256 innerPublished,) = PsmPayload.decode(_publishedPayload(0));
        (,, uint256 outerPublished,) = PsmPayload.decode(_publishedPayload(1));
        assertEq(
            innerPublished + outerPublished, held, "published mint total must not exceed what the reserve holds"
        );
    }

    /// @dev Regression: `deposit(0, ...)` must revert `ZeroAmount` even when a reentrant token's
    ///      callback feeds real balance into the vault mid-transfer. The cap must run BEFORE the
    ///      zero-check: capping first bounds the raw (uncapped, reentrancy-inflated) delta down to
    ///      `amount` (0) before the zero-check ever sees it. Swapping the two lines lets the
    ///      zero-check see the inflated, still-nonzero raw delta, pass it through, and only then
    ///      cap it to zero — at which point `deposit` proceeds with `received = 0` instead of
    ///      reverting: a wasted `KIND_MINT` publish that moves no value, not the named revert.
    function test_deposit_zeroAmountRevertsEvenWithReentrantFunding() public {
        address innerRecipient = makeAddr("innerRecipient");
        address outerRecipient = makeAddr("outerRecipient");
        uint256 innerAmount = 50_000e6;

        usdc.mint(address(usdc), innerAmount);
        usdc.selfApprove(address(vault));

        usdc.armReentry(
            address(vault),
            abi.encodeCall(HollarBaseVault.deposit, (innerAmount, PsmPayload.fromAddress(innerRecipient)))
        );

        vm.prank(alice);
        vm.expectRevert(ZeroAmount.selector);
        vault.deposit(0, PsmPayload.fromAddress(outerRecipient));

        // The whole call reverted, so nothing survives from either frame — not even the nested
        // deposit's own otherwise-valid mint.
        assertEq(wormhole.publishedCount(), 0, "no publish, from either frame");
        assertEq(vault.principal(), 0, "no state survives the revert");
    }

    function _publishedPayload(uint256 index) internal view returns (bytes memory payload) {
        (, payload,,) = wormhole.published(index);
    }
}
