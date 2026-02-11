// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

contract MessageSender {
    IWormhole public wormhole;
    uint32 public nonce;

    constructor(address _wormhole) {
        wormhole = IWormhole(_wormhole);
    }

    function quoteCrossChainCost() public view returns (uint256 cost) {
        cost = wormhole.messageFee();
    }

    function sendMessage(string memory message) external payable returns (uint64 sequence) {
        uint256 cost = wormhole.messageFee();
        require(msg.value >= cost, "Insufficient funds for message fee");

        sequence = wormhole.publishMessage{value: cost}(
            nonce,
            abi.encode(message),
            1 // finality: finalized
        );

        nonce++;
    }
}
