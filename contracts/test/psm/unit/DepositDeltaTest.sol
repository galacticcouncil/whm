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
    MockFeeOnTransferToken,
    MockWormholeCore
} from "../mocks/PsmMocks.sol";

/// @title Deposit accounts the observed balance delta, never the caller's argument
/// @notice xchain#55: a caller-supplied `amount` that does not match what the vault actually
///         received would let the rate limit, `principal`, and the published mint figure disagree
///         with the reserve's real balance. Regression fixture uses a fee-on-transfer token to
///         prove the vault measures its own balance delta across the transfer, not the argument.
contract DepositDeltaTest is Test, IHollarBaseVault {
    HollarBaseVault internal vault;
    MockFeeOnTransferToken internal usdc;
    MockAToken internal aUsdc;
    MockAavePool internal pool;
    MockWormholeCore internal wormhole;

    uint16 internal constant HYDRATION_CHAIN = 73;
    bytes32 internal constant HYDRATION_EMITTER = bytes32(uint256(0x4bd7a));
    uint256 internal constant MIN_PRICE = 99e6;
    /// @dev 1% — enough that a naive `amount`-based accounting is trivially distinguishable from
    ///      the observed delta.
    uint256 internal constant FEE_BPS = 100;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal treasurer = makeAddr("treasurer");
    address internal alice = makeAddr("alice");

    function _deployVault(uint256 feeBps) internal {
        wormhole = new MockWormholeCore(30, 0);
        usdc = new MockFeeOnTransferToken("FEE-USDC", 6, feeBps);
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
        vault.setDepositLimit(1_000_000e6, 1 days);
        vm.stopPrank();

        vm.prank(guardian);
        vault.setDepositsPaused(false);

        usdc.mint(alice, 1_000_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
    }

    /// @dev A short-transferring token: the vault must account, rate-limit, and publish the 990
    ///      that actually arrived, never the 1,000 alice asked to send.
    function test_deposit_accountsObservedDeltaNotCallerAmount() public {
        _deployVault(FEE_BPS);

        uint256 requested = 1_000e6;
        uint256 received = requested - (requested * FEE_BPS) / 10_000;

        vm.prank(alice);
        vault.deposit(requested, PsmPayload.fromAddress(alice));

        assertEq(vault.principal(), received, "principal books the delta, not the argument");
        assertEq(vault.depositAllowance(), 1_000_000e6 - received, "rate limit charges the delta");

        (, bytes32 recipient, uint256 published,) = PsmPayload.decode(wormhole.lastPublished().payload);
        assertEq(PsmPayload.toAddress(recipient), alice);
        assertEq(published, received, "published figure is the delta, not the argument");

        assertEq(usdc.balanceOf(address(vault)) + aUsdc.balanceOf(address(vault)), received, "reserve holds only what arrived");
    }

    /// @dev A token that eats the entire transfer must not silently book a zero-value deposit.
    function test_deposit_revertsOnZeroDelta() public {
        _deployVault(10_000); // 100% fee — nothing arrives

        vm.prank(alice);
        vm.expectRevert(ZeroAmount.selector);
        vault.deposit(1_000e6, PsmPayload.fromAddress(alice));
    }
}
