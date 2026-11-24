// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IFiatToken — the one Circle USDC read the vault makes
interface IFiatToken {
    function isBlacklisted(address account) external view returns (bool);
}
