// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {HollarBaseVault} from "../../../src/psm/HollarBaseVault.sol";
import {IPool, IPoolAddressesProvider} from "../../../src/psm/interfaces/IAave.sol";
import {IHollarBaseVault} from "../../../src/psm/interfaces/IHollarBaseVault.sol";
import {PsmPayload} from "../../../src/psm/lib/PsmPayload.sol";
import {RateLimiter} from "../../../src/psm/lib/RateLimiter.sol";

/// @title The vault against real Base mainnet
/// @notice Every address here is the one the migration will use, and the assertions are about the
///         things a mock cannot tell you: what Aave's oracle actually is on this chain, how often
///         the feed really updates, and whether a withdrawal comes back at all.
///
/// @dev Skipped unless a Base RPC is reachable, so the default suite stays offline.
contract BaseAaveForkTest is Test, IHollarBaseVault {
    // ─── Verified on Base mainnet ───────────────────────────────

    /// @dev Native Circle USDC. NOT USDbC — that one is "USD Base Coin" and is a different asset.
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant AUSDC = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;
    address internal constant ADDRESSES_PROVIDER = 0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D;
    address internal constant WORMHOLE_CORE = 0xbebdb6C8ddC678FfA9f8748f85C815C556Dd8ac6;


    uint16 internal constant HYDRATION_CHAIN = 73;
    uint256 internal constant MIN_PRICE = 99e6;

    HollarBaseVault internal vault;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal treasurer = makeAddr("treasurer");
    address internal alice = makeAddr("alice");

    bool internal forked;

    function setUp() public {
        try vm.createSelectFork(vm.rpcUrl("base")) {
            forked = true;
        } catch {
            return;
        }

        HollarBaseVault implementation = new HollarBaseVault();
        vault = HollarBaseVault(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(
                        HollarBaseVault.initializeVault,
                        (
                            VaultInit({
                                wormhole: WORMHOLE_CORE,
                                usdc: USDC,
                                aUsdc: AUSDC,
                                addressesProvider: ADDRESSES_PROVIDER,
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
        vault.setHydrationEmitter(bytes32(uint256(0x4bd7a)));
        vault.setDepositLimit(RateLimiter.UNLIMITED, 0);
        vm.stopPrank();

        vm.prank(guardian);
        vault.setDepositsPaused(false);

        deal(USDC, alice, 1_000_000e6);
        vm.prank(alice);
        IERC20(USDC).approve(address(vault), type(uint256).max);
    }

    /// @dev A borrow drains the aToken's holding AND Aave's virtual balance together. Dealing the
    ///      aToken down on its own leaves virtual above actual, which cannot happen on chain and
    ///      is the inverse of a squeeze -- it hides exactly the over-reporting being tested for.
    function _squeeze(uint256 remaining) internal {
        deal(USDC, AUSDC, remaining);
        vm.mockCall(
            IPoolAddressesProvider(ADDRESSES_PROVIDER).getPool(),
            abi.encodeWithSelector(IPool.getVirtualUnderlyingBalance.selector, USDC),
            abi.encode(uint128(remaining))
        );
    }

    modifier onFork() {
        if (!forked) {
            vm.skip(true);
        }
        _;
    }

    // ─── What the addresses actually are ────────────────────────

    function test_addressesResolve() public onFork {
        IPoolAddressesProvider provider = IPoolAddressesProvider(ADDRESSES_PROVIDER);
        assertTrue(provider.getPool() != address(0), "pool");
        assertTrue(provider.getPriceOracle() != address(0), "oracle");

        assertEq(IERC20Metadata(USDC).symbol(), "USDC");
        assertEq(IERC20Metadata(USDC).decimals(), 6);
        assertEq(IERC20Metadata(AUSDC).symbol(), "aBasUSDC");
    }




    // ─── Real Aave round trip ───────────────────────────────────

    function test_depositSuppliesToRealAave() public onFork {
        vm.prank(alice);
        vault.deposit(10_000e6, PsmPayload.fromAddress(alice));

        assertEq(vault.principal(), 10_000e6);
        // Aave scales the supply by a liquidity index that keeps moving, so the aToken balance
        // rounds down by a wei or two depending on the block this forks at. A 1-wei tolerance
        // against `latest` fails intermittently and teaches everyone to ignore a red suite; the
        // bound below is still ~six orders of magnitude tighter than any real accounting error.
        assertApproxEqAbs(IERC20(AUSDC).balanceOf(address(vault)), 10_000e6, 100, "supplied to Aave");
        assertEq(IERC20(USDC).balanceOf(address(vault)), 0, "nothing left idle");
    }

    /// @dev aUSDC rebases. The vault must be able to pay the full credit back out of a real
    ///      reserve after time has passed, and the surplus that accrues must not go negative.
    function test_reserveSurvivesRebaseAndPaysOut() public onFork {
        vm.prank(alice);
        vault.deposit(10_000e6, PsmPayload.fromAddress(alice));

        vm.warp(block.timestamp + 30 days);

        uint256 supplied = IERC20(AUSDC).balanceOf(address(vault));
        assertGe(supplied, 10_000e6, "aUSDC only rebases upward");
        assertGe(vault.surplus(), 0);

        vm.prank(guardian);
        vault.emergencyUnwindAave(10_000e6);

        assertEq(IERC20(USDC).balanceOf(address(vault)), 10_000e6, "the reserve comes back whole");
    }

    // ─── High utilisation ───────────────────────────────────────

    /// @dev The Base USDC market runs hot: at the time of writing 88% of $176M supplied is
    ///      borrowed, leaving ~$20M withdrawable. Redemption capacity is that residual, not the
    ///      headline supply, and it shrinks fast as utilisation climbs. Measured here rather than
    ///      asserted so a change in Aave's shape shows up as a diff.
    function test_utilisationIsHighAndLiquidityIsTheResidual() public onFork {
        uint256 supplied = IERC20(AUSDC).totalSupply();
        uint256 withdrawable = IERC20(USDC).balanceOf(AUSDC);

        assertLt(withdrawable, supplied / 2, "this market is mostly borrowed, not idle");
        emit log_named_decimal_uint("supplied     ", supplied, 6);
        emit log_named_decimal_uint("withdrawable ", withdrawable, 6);
        emit log_named_uint("utilisation %", 100 - (withdrawable * 100) / supplied);
    }

    /// @dev A redemption larger than what Aave can release must degrade, not fail: the credit
    ///      stands in full, nothing is paid while the reserve is short of the whole of it, and it
    ///      settles in one fill when liquidity returns. Whole-fill against the real reserve.
    function test_redemptionDegradesUnderALiquiditySqueeze() public onFork {
        uint256 deposited = 1_000_000e6;
        deal(USDC, alice, deposited);
        vm.prank(alice);
        vault.deposit(deposited, PsmPayload.fromAddress(alice));

        // Credit the redemption straight through the books; the VAA path is covered elsewhere.
        // Ordered before the squeeze because _creditViaVaa clears all mocks on its way out.
        vm.prank(address(vault));
        _creditViaVaa(alice, deposited);

        // Squeeze the reserve to well under the outstanding claim, as a utilisation spike would.
        uint256 squeezed = 250_000e6;
        _squeeze(squeezed);

        uint256 fee = (deposited * 5) / 10_000;
        assertEq(vault.owed(alice), deposited - fee, "credited in full despite the squeeze");

        // Whole-fill: 250,000 against a 999,500 credit is not a part payment, it is no payment.
        assertEq(vault.claimable(alice), 0, "short of the whole credit is not claimable");
        assertEq(vault.drain(5), 0, "so nothing is paid");
        assertEq(IERC20(USDC).balanceOf(alice), 0, "and she receives nothing yet");
        assertEq(vault.owed(alice), deposited - fee, "the credit is intact");
        (address head,) = vault.queueHeadEntry();
        assertEq(head, alice, "still at the head");

        // Borrowers repay; the queue finishes in one fill.
        _squeeze(2_000_000e6);
        assertEq(vault.drain(5), deposited - fee, "paid whole once liquidity returned");
        assertEq(vault.owed(alice), 0, "settled");
        assertEq(vault.totalOwed(), 0);
    }

    /// @dev The exit from a stall, against the real reserve: the redeemer takes their claim back
    ///      rather than waiting on Aave utilisation they do not control.
    function test_stalledRedemptionCanBeCancelled() public onFork {
        uint256 deposited = 1_000_000e6;
        deal(USDC, alice, deposited);
        vm.prank(alice);
        vault.deposit(deposited, PsmPayload.fromAddress(alice));

        vm.prank(address(vault));
        _creditViaVaa(alice, deposited);
        _squeeze(250_000e6);

        uint256 principalAfterCredit = vault.principal();
        assertEq(vault.drain(5), 0, "stalled");

        (bool found, uint256 index,) = vault.queueEntryOf(alice);
        assertTrue(found, "her credit is queued");

        vm.prank(alice);
        vault.cancelQueuedRedemption(index);

        assertEq(vault.owed(alice), 0, "no longer queued");
        assertEq(vault.totalOwed(), 0);
        assertEq(vault.principal(), principalAfterCredit + deposited, "gross returns to backing");
    }

    /// @dev Feeds a redeem message in as the Hydration emitter would.
    function _creditViaVaa(address recipient, uint256 amount) internal {
        vm.mockCall(
            WORMHOLE_CORE,
            abi.encodeWithSelector(bytes4(keccak256("parseAndVerifyVM(bytes)"))),
            abi.encode(_vm(recipient, amount), true, "")
        );
        vault.receiveMessage(hex"00");
        vm.clearMockedCalls();
    }

    function _vm(address recipient, uint256 amount) internal pure returns (IWormhole.VM memory v) {
        v.emitterChainId = HYDRATION_CHAIN;
        v.emitterAddress = bytes32(uint256(0x4bd7a));
        v.payload =
            PsmPayload.encode(PsmPayload.KIND_REDEEM, PsmPayload.fromAddress(recipient), amount);
        v.hash = keccak256(abi.encode(recipient, amount));
    }

    /// @dev Aave's withdrawable liquidity is the underlying held by the aToken, not our aUSDC
    ///      balance. Pinned against the real reserve so the distinction stays visible.
    function test_reserveLiquidityIsUnderlyingHeldByAToken() public onFork {
        uint256 poolLiquidity = IERC20(USDC).balanceOf(AUSDC);
        assertGt(poolLiquidity, 1_000_000e6, "Base USDC market should hold well over $1M");
    }
}

interface IERC20Metadata {
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}
