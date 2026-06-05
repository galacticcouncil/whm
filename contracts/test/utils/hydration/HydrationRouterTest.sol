// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console2} from "forge-std/Test.sol";
import {HydrationRouter} from "../../../src/utils/hydration/HydrationRouter.sol";

/// @notice Byte-level checks for pallet_route_executor calldata encoders.
///         Run with `forge test --mc HydrationRouterTest -vv` to print the calldata hex
///         and diff it against SDK/papi-generated calldata.
contract HydrationRouterTest is Test {
    // asset_in=5, asset_out=20, amount=1, route=empty
    // 43(pallet 67) | 00(sell) | 05000000(u32) | 14000000(u32) | u128Le(1) | u128Le(1) | 00(route)
    function test_encodeSell_bytes() public pure {
        bytes memory call = HydrationRouter.encodeSell(5, 20, 1, 1);
        assertEq(
            call,
            hex"4300" hex"05000000" hex"14000000" hex"01000000000000000000000000000000"
                hex"01000000000000000000000000000000" hex"00"
        );
    }

    // 43(pallet 67) | 01(buy) | 05000000 | 14000000 | u128Le(1) | u128Le(1) | 00
    function test_encodeBuy_bytes() public pure {
        bytes memory call = HydrationRouter.encodeBuy(5, 20, 1, 1);
        assertEq(
            call,
            hex"4301" hex"05000000" hex"14000000" hex"01000000000000000000000000000000"
                hex"01000000000000000000000000000000" hex"00"
        );
    }

    // Copy-paste helpers: print realistic calldata for external comparison.
    function test_log_sell_realistic() public pure {
        // sell asset 5 → WETH (asset 20), amount_in 1e18, min_out 9e17
        bytes memory call = HydrationRouter.encodeSell(5, 20, 1e18, 9e17);
        console2.log("router.sell(5 -> 20, 1e18, min 9e17):");
        console2.logBytes(call);
    }

    function test_log_buy_realistic() public pure {
        // buy 1 GLMR (asset 16, amount 1e18) paying asset 5, max_in 100e18
        bytes memory call = HydrationRouter.encodeBuy(5, 16, 1e18, 100e18);
        console2.log("router.buy(5 -> 16 GLMR, out 1e18, max 100e18):");
        console2.logBytes(call);
    }
}
