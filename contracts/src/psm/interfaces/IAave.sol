// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Aave v3 surface used by the vault
/// @dev Pool and oracle are resolved from the addresses provider rather than pinned, so an Aave
///      migration does not strand the reserve behind a stale address.
interface IPoolAddressesProvider {
    function getPool() external view returns (address);
    function getPriceOracle() external view returns (address);
}

interface IPool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    /// @notice The balance a withdrawal is actually charged against, v3.3 onward.
    /// @dev Not `usdc.balanceOf(aToken)`. The aToken's raw holding also counts donations, which
    ///      Aave never credits and never lets out — measured at 230.7 USDC on Base — so sizing a
    ///      payout by it asks the pool for more than it will release and reverts the whole call.
    function getVirtualUnderlyingBalance(address asset) external view returns (uint128);
}

interface IAaveOracle {
    /// @notice Aave's own price, in the oracle's USD base (8 dp on Base).
    /// @dev This is the number Aave itself lends against, capped adapters included. It carries no
    ///      timestamp, which is why staleness is checked against a separately configured feed.
    function getAssetPrice(address asset) external view returns (uint256);

    /// @notice The aggregator Aave has chosen for this asset.
    /// @dev Not on the deposit path. On Base this resolves to a "Capped USDC/USD" adapter that
    ///      implements `latestAnswer` but reverts on `latestRoundData`, so it cannot be the
    ///      staleness source. Kept for off-chain verification of what Aave is actually reading.
    function getSourceOfAsset(address asset) external view returns (address);
}

interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
