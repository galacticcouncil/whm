// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface IInstaTransfer {
    function transfer(address asset, uint256 amount, address recipient) external;
}
