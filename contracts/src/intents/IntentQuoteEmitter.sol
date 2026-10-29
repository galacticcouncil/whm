// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {IIntentQuoteEmitter} from "./interfaces/IIntentQuoteEmitter.sol";
import {IntentCodec} from "./IntentCodec.sol";

/// @title IntentQuoteEmitter — order messages for NEAR's IntentRouter
/// @notice One entry point: publish an order's price for the account its terms derive. Thin and
///         stable on purpose — the router pins this address as the only emitter it reads, so price
///         sources and rail changes live in the dispatcher, which can be replaced without repointing
///         NEAR. See docs/intents-v2/{spec,schema}.md.
contract IntentQuoteEmitter is Initializable, UUPSUpgradeable, IIntentQuoteEmitter {
    /// @notice Orders carry a price the router acts on, so they wait for finality like the rail's
    ///         own messages.
    uint8 public constant CONSISTENCY_FINALIZED = 202;

    IWormhole public wormhole;
    address public owner;
    uint32 public nonce;

    /// @notice Contracts allowed to publish orders — each is a price authority for every path.
    mapping(address => bool) public isDispatcher;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ─── Init ────────────────────────────────────────────────────

    constructor() {
        _disableInitializers();
    }

    function initialize(address _wormhole) public initializer {
        wormhole = IWormhole(_wormhole);
        owner = msg.sender;
    }

    // ─── Orders ──────────────────────────────────────────────────

    /// @inheritdoc IIntentQuoteEmitter
    function publishOrder(Quote calldata terms, Order calldata order)
        external
        payable
        returns (bytes32 authPath, uint64 messageSequence)
    {
        if (!isDispatcher[msg.sender]) revert NotDispatcher();
        if (order.outPerIn == 0) revert ZeroRate();

        bytes memory encoded = IntentCodec.encodeQuote(terms);
        authPath = keccak256(encoded);

        uint256 fee = wormhole.messageFee();
        if (msg.value != fee) revert InvalidMessageFee(fee, msg.value);

        messageSequence = wormhole.publishMessage{value: fee}(
            nonce, IntentCodec.encodeOrder(authPath, order), CONSISTENCY_FINALIZED
        );
        nonce++;

        emit OrderPublished(authPath, order.seq, msg.sender, order.amount, order.outPerIn, messageSequence, encoded);
    }

    /// @inheritdoc IIntentQuoteEmitter
    function computeAuthPath(Quote calldata terms) external pure returns (bytes32) {
        return IntentCodec.authPath(terms);
    }

    /// @inheritdoc IIntentQuoteEmitter
    function computeTerms(Quote calldata terms) external pure returns (bytes memory) {
        return IntentCodec.encodeQuote(terms);
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override onlyOwner {}

    // ─── Admin ───────────────────────────────────────────────────

    /// @inheritdoc IIntentQuoteEmitter
    function setDispatcher(address dispatcher, bool authorized) external onlyOwner {
        isDispatcher[dispatcher] = authorized;
        emit DispatcherSet(dispatcher, authorized);
    }

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }
}
