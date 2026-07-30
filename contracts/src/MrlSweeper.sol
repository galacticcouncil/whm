// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface ITokenBridge {
    function transferTokens(
        address token,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        uint256 arbiterFee,
        uint32 nonce
    ) external payable returns (uint64);
}

/// drains the full current balance of `token` from the Hydration Moonbeam sovereign account (SA)
/// over the Wormhole token bridge. straggler-safe: reads balance at execution, zero-balance is a no-op.
contract MrlSweeper {
    address public immutable SA;
    ITokenBridge public immutable BRIDGE;

    constructor(address sa, address bridge) {
        SA = sa;
        BRIDGE = ITokenBridge(bridge);
    }

    function sweep(IERC20 token, uint16 chain, bytes32 recipient) external returns (uint64 seq) {
        require(msg.sender == SA, "only SA");
        uint256 bal = token.balanceOf(SA);
        if (bal == 0) return 0;
        token.transferFrom(SA, address(this), bal);
        token.approve(address(BRIDGE), bal);
        seq = BRIDGE.transferTokens(address(token), bal, chain, recipient, 0, 0);
    }
}
