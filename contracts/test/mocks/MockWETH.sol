// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @notice Minimal WETH9: native-backed wrapped token with withdraw + ERC20 transfer, for tests.
contract MockWETH {
    mapping(address => uint256) public balanceOf;

    /// @dev Credit `to` with wrapped tokens backed by the attached ETH (used to seed a holder).
    function mintTo(address to) external payable {
        balanceOf[to] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "withdraw failed");
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
