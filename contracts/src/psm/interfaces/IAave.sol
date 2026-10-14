// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Aave v3 surface used by the vault
/// @dev Pool and oracle are resolved from the addresses provider at call time, the canonical Aave
///      pattern: a pool implementation or oracle swap registered on this provider is followed. A
///      market migration is not — the provider and the aToken are pinned at init — and a pool
///      re-registered on this provider would leave the pinned aToken's liquidity unreadable until
///      an upgrade. Aave does neither in practice; both addresses are stable proxies.
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
    ///      timestamp; the floor is the whole gate (see `HollarBaseVault._checkOracle`).
    function getAssetPrice(address asset) external view returns (uint256);
}
