// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {MessageReceiver} from "./MessageReceiver.sol";

contract HydrationRouter is MessageReceiver {
    struct PriceData {
        uint256 price;
        uint64 timestamp;
        uint64 receivedAt;
    }
    mapping(bytes32 => PriceData) public latestPrices;

    uint8 constant ACTION_PRICE_UPDATE = 1;

    event PriceReceived(bytes32 indexed assetId, uint256 price, uint64 timestamp);

    constructor(address _wormholeRelayer, address _wormhole) MessageReceiver(_wormholeRelayer, _wormhole) {}

    function _processMessage(bytes memory payload) internal virtual override {
        uint8 action = uint8(payload[31]);

        if (action == ACTION_PRICE_UPDATE) {
            _handlePriceUpdate(payload);
        } else {
            super._processMessage(payload);
        }
    }

    function _handlePriceUpdate(bytes memory payload) internal virtual {
        (, bytes32 assetId, uint256 price, uint64 timestamp) = abi.decode(payload, (uint8, bytes32, uint256, uint64));

        latestPrices[assetId] = PriceData({price: price, timestamp: timestamp, receivedAt: uint64(block.timestamp)});
        emit PriceReceived(assetId, price, timestamp);
    }
}
