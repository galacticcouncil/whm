// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {ScaleCodec} from "../ScaleCodec.sol";

/// @title HydrationRouter — encoders for "router" pallet.
/// @notice Amounts are plain (non-compact) u128 LE; asset ids are u32 LE. Empty route (compact 0)
///         lets the router resolve the on-chain default route.
library HydrationRouter {
    uint8 internal constant PALLET = 67;

    uint8 internal constant SELL = 0; // router.sell
    uint8 internal constant BUY = 1; // router.buy

    /// @dev router.buy(asset_in, asset_out, amount_out, max_amount_in, route)
    function encodeBuy(uint32 assetIn, uint32 assetOut, uint256 amountOut, uint256 maxAmountIn)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            PALLET,
            BUY,
            ScaleCodec.u32Le(assetIn),
            ScaleCodec.u32Le(assetOut),
            ScaleCodec.u128Le(uint128(amountOut)),
            ScaleCodec.u128Le(uint128(maxAmountIn)),
            uint8(0x00) // route: empty Vec<Trade>
        );
    }

    /// @dev router.sell(asset_in, asset_out, amount_in, min_amount_out, route)
    function encodeSell(uint32 assetIn, uint32 assetOut, uint256 amountIn, uint256 minAmountOut)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            PALLET,
            SELL,
            ScaleCodec.u32Le(assetIn),
            ScaleCodec.u32Le(assetOut),
            ScaleCodec.u128Le(uint128(amountIn)),
            ScaleCodec.u128Le(uint128(minAmountOut)),
            uint8(0x00) // route: empty Vec<Trade>
        );
    }
}
