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
    uint256 constant ORACLE_PRICE_SCALE_DIVISOR = 1e10;

    /// @notice action -> handler contract (e.g. ACTION_PRICE_UPDATE -> XcmTransactor)
    mapping(uint8 => address) public handlers;

    /// @notice assetId -> oracle contract address on Hydration (dest for evm.call)
    mapping(bytes32 => address) public oracles;

    error HandlerNotSet(uint8 action);
    error OracleNotSet(bytes32 assetId);
    error StalePriceUpdate(bytes32 assetId, uint64 incomingTimestamp, uint64 latestTimestamp);

    event PriceReceived(bytes32 indexed assetId, uint256 price, uint64 timestamp);

    function initialize(address _wormhole) public override initializer {
        _initMessageReceiver(_wormhole);
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
        uint64 latestTimestamp = latestPrices[assetId].timestamp;
        if (timestamp < latestTimestamp) revert StalePriceUpdate(assetId, timestamp, latestTimestamp);

        latestPrices[assetId] = PriceData({price: price, timestamp: timestamp, receivedAt: uint64(block.timestamp)});
        emit PriceReceived(assetId, price, timestamp);

        address handler = handlers[ACTION_PRICE_UPDATE];
        address oracle = oracles[assetId];
        
        if (handler == address(0)) revert HandlerNotSet(ACTION_PRICE_UPDATE);
        if (oracle == address(0)) revert OracleNotSet(assetId);

        uint256 scaledPrice = price / ORACLE_PRICE_SCALE_DIVISOR;
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes memory input = abi.encodeWithSignature("setPrice(int256)", int256(scaledPrice));
        XcmTransactor(handler).transact(oracle, input);
    }

    // ─── Admin ─────────────────────────────────────────────────

    function setHandler(uint8 action, address handler) external onlyOwner {
        handlers[action] = handler;
    }

    function setOracle(bytes32 assetId, address oracle) external onlyOwner {
        oracles[assetId] = oracle;
    }
}
