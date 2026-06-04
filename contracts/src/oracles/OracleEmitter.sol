// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

contract OracleEmitter is Initializable, UUPSUpgradeable {
    struct Feed {
        address source;
        bytes call;
    }

    IWormhole public wormhole;
    uint32 public nonce;
    address public owner;

    mapping(bytes32 => Feed) public feeds;

    uint8 constant ACTION_RATE_UPDATE = 2;
    uint8 constant CONSISTENCY_FINALIZED = 200;

    event FeedRegistered(bytes32 indexed assetId, address source);
    event FeedRemoved(bytes32 indexed assetId);
    event RatePublished(bytes32 indexed assetId, uint256 rate, uint64 sequence);

    error NotOwner();
    error FeedNotRegistered(bytes32 assetId);
    error InvalidSource(address source);
    error SourceCallFailed(bytes32 assetId, bytes returnData);
    error InvalidSourceReturn(bytes32 assetId);
    error InsufficientFee(uint256 sent, uint256 required);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        _disableInitializers();
    }

    function initialize(address _wormhole) public initializer {
        wormhole = IWormhole(_wormhole);
        owner = msg.sender;
    }

    // ─── Core ────────────────────────────────────────────────────

    function quoteCrossChainCost() external view returns (uint256) {
        return wormhole.messageFee();
    }

    function send(bytes32 assetId) external payable returns (uint64 sequence) {
        Feed memory feed = feeds[assetId];
        if (feed.source == address(0)) revert FeedNotRegistered(assetId);

        uint256 rate = _readSource(assetId, feed);
        uint64 ts = uint64(block.timestamp);
        bytes memory payload = abi.encode(ACTION_RATE_UPDATE, assetId, rate, ts);

        uint256 fee = wormhole.messageFee();
        if (msg.value < fee) revert InsufficientFee(msg.value, fee);

        uint32 n = nonce;
        nonce = n + 1;

        sequence = wormhole.publishMessage{value: fee}(n, payload, CONSISTENCY_FINALIZED);
        emit RatePublished(assetId, rate, sequence);
    }

    // ─── Internal ────────────────────────────────────────────────

    function _readSource(bytes32 assetId, Feed memory feed) internal view returns (uint256) {
        (bool ok, bytes memory ret) = feed.source.staticcall(feed.call);
        if (!ok) revert SourceCallFailed(assetId, ret);
        if (ret.length < 32) revert InvalidSourceReturn(assetId);
        return abi.decode(ret, (uint256));
    }

    // ─── Admin ───────────────────────────────────────────────────

    function registerFeed(bytes32 assetId, address source, bytes calldata call) external onlyOwner {
        if (source == address(0)) revert InvalidSource(source);
        feeds[assetId] = Feed({source: source, call: call});
        emit FeedRegistered(assetId, source);
    }

    function removeFeed(bytes32 assetId) external onlyOwner {
        delete feeds[assetId];
        emit FeedRemoved(assetId);
    }

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override onlyOwner {}
}
