// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {INttManager} from "../ntt/interfaces/INttManager.sol";

interface IWETH9 {
    function deposit() external payable;
}

/// @title WethHubFunder - turns native ETH (a Snowbridge unlock) into WETH escrow of one NTT hub
/// @notice No owner and no upgrade path: the only destination is the hub fixed at deployment.
contract WethHubFunder {
    using SafeERC20 for IERC20;

    address public immutable weth;
    address public immutable hub;

    event Funded(uint256 amount);

    error ZeroAddress();
    error HubTokenMismatch(address token);
    error NothingToFund();

    constructor(address weth_, address hub_) {
        if (weth_ == address(0) || hub_ == address(0)) revert ZeroAddress();
        address token = INttManager(hub_).token();
        if (token != weth_) revert HubTokenMismatch(token);
        weth = weth_;
        hub = hub_;
    }

    // must never revert: snowbridge consumes the message even if the recipient call fails
    receive() external payable {}

    function fund() external {
        uint256 ether_ = address(this).balance;
        if (ether_ > 0) IWETH9(weth).deposit{value: ether_}();

        uint256 amount = IERC20(weth).balanceOf(address(this));
        if (amount == 0) revert NothingToFund();

        IERC20(weth).safeTransfer(hub, amount);
        emit Funded(amount);
    }
}
