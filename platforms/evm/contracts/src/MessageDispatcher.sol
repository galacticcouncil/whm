// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";
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
    uint8 constant ACTION_RATE_UPDATE = 2;
    uint256 constant PRICE_SCALE_DIVISOR = 1e10;

    uint64 public maxPriceAge;

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
        maxPriceAge = 300; // 5 minutes default
    }

    // ─── Message routing ───────────────────────────────────────

    function _processMessage(IWormhole.VM memory vm) internal virtual override {
        uint8 action = uint8(vm.payload[31]);

        if (action == ACTION_PRICE_UPDATE || action == ACTION_RATE_UPDATE) {
            _handleOracleUpdate(action, vm);
        } else {
            super._processMessage(vm);
        }
    }

    function _handleOracleUpdate(uint8 action, IWormhole.VM memory vm) internal virtual {
        (, bytes32 assetId, uint256 price,) = abi.decode(vm.payload, (uint8, bytes32, uint256, uint64));
        uint64 vaaTimestamp = uint64(vm.timestamp);
        uint64 latestTimestamp = latestPrices[assetId].timestamp;
        if (vaaTimestamp <= latestTimestamp) revert StalePriceUpdate(assetId, vaaTimestamp, latestTimestamp);
        require(block.timestamp - vaaTimestamp <= maxPriceAge, "Price too stale");

        address handler = handlers[action];
        address oracle = oracles[assetId];

        if (handler == address(0)) revert HandlerNotSet(action);
        if (oracle == address(0)) revert OracleNotSet(assetId);

        latestPrices[assetId] = PriceData({price: price, timestamp: vaaTimestamp, receivedAt: uint64(block.timestamp)});
        emit PriceReceived(assetId, price, vaaTimestamp);

        uint256 scaledPrice = price / PRICE_SCALE_DIVISOR;
        require(scaledPrice > 0, "Price too low to scale");
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

    function setMaxPriceAge(uint64 _maxPriceAge) external onlyOwner {
        maxPriceAge = _maxPriceAge;
    }
}
