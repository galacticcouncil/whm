// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

contract MessageEmitter is Initializable, UUPSUpgradeable {
    IWormhole public wormhole;
    uint32 public nonce;

    address public owner;

    error NotOwner();

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    constructor() {
        _disableInitializers();
    }

    function initialize(address _wormhole) public virtual initializer {
        _initMessageEmitter(_wormhole);
    }

    function _initMessageEmitter(address _wormhole) internal onlyInitializing {
        wormhole = IWormhole(_wormhole);
        owner = msg.sender;
    }

    // ─── Core ────────────────────────────────────────────────────

    function quoteCrossChainCost() public view returns (uint256 cost) {
        cost = wormhole.messageFee();
    }

    function sendMessage(string memory message) external payable returns (uint64 sequence) {
        uint256 cost = wormhole.messageFee();
        require(msg.value >= cost, "Insufficient funds for message fee");

        sequence = wormhole.publishMessage{value: cost}(
            nonce,
            abi.encode(message),
            200 // finality: instant
        );

        nonce++;
    }

    // ─── Internal ────────────────────────────────────────────────

    function _onlyOwner() internal view {
        if (msg.sender != owner) revert NotOwner();
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view virtual override {
        _onlyOwner();
    }

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }
}
