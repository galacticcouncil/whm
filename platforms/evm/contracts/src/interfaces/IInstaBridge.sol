// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

interface IInstaBridge {
    function bridgeViaWormhole(
        address asset,
        uint256 amount,
        uint16 destChain,
        address destAsset,
        bytes32 recipient
    ) external payable returns (uint64 transferSequence, uint64 messageSequence);

    function completeTransfer(bytes memory vaa) external;

    function quoteFee(uint256 amount) external view returns (uint256 fee);
}
