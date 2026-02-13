// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {MessageReceiver} from "./MessageReceiver.sol";
import {XcmTransactor} from "./XcmTransactor.sol";

contract MessageDispatcher is MessageReceiver {
    struct PriceData {
        uint256 price;
        uint64 timestamp;
        uint64 receivedAt;
    }
    mapping(bytes32 => PriceData) public latestPrices;

    uint8 constant ACTION_PRICE_UPDATE = 1;

    /// @notice action -> handler contract (e.g. ACTION_PRICE_UPDATE -> XcmTransactor)
    mapping(uint8 => address) public handlers;

    /// @notice assetId -> oracle contract address on Hydration (dest for evm.call)
    mapping(bytes32 => address) public oracles;

    event PriceReceived(bytes32 indexed assetId, uint256 price, uint64 timestamp);

    function initialize(address _wormholeRelayer, address _wormhole) public override initializer {
        _initMessageReceiver(_wormholeRelayer, _wormhole);
    }

    // ─── Message routing ───────────────────────────────────────

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

        address handler = handlers[ACTION_PRICE_UPDATE];
        address oracle = oracles[assetId];
        if (handler != address(0) && oracle != address(0)) {
            bytes memory input =
                abi.encodeWithSignature("updatePrice(bytes32,uint256,uint64)", assetId, price, timestamp);
            XcmTransactor(handler).transact(oracle, input);
        }
    }

    // ─── Admin ─────────────────────────────────────────────────

    function setHandler(uint8 action, address handler) external onlyOwner {
        handlers[action] = handler;
    }

    function setOracle(bytes32 assetId, address oracle) external onlyOwner {
        oracles[assetId] = oracle;
    }
}
