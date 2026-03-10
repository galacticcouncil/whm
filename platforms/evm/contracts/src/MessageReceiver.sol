// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

contract MessageReceiver is Initializable, UUPSUpgradeable {
    IWormhole public wormhole;

    address public owner;
    mapping(address => bool) public authorized;
    mapping(uint16 => bytes32) public authorizedEmitters;

    mapping(bytes32 => bool) public processedVaas;

    event MessageReceived(string message);

    error NotOwner();
    error NotAuthorizedEmitter();

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    modifier onlyAuthorizedEmitter(uint16 sourceChain, bytes32 sourceAddress) {
        _onlyAuthorizedEmitter(sourceChain, sourceAddress);
        _;
    }

    constructor() {
        _disableInitializers();
    }

    function initialize(address _wormhole) public virtual initializer {
        _initMessageReceiver(_wormhole);
    }

    function _initMessageReceiver(address _wormhole) internal onlyInitializing {
        wormhole = IWormhole(_wormhole);
        owner = msg.sender;
    }

    // ─── Receive ────────────────────────────────────────────────

    function receiveMessage(bytes memory vaa) public {
        (IWormhole.VM memory vm, bool valid, string memory reason) = wormhole.parseAndVerifyVM(vaa);
        require(valid, reason);

        require(!processedVaas[vm.hash], "VAA already processed");
        processedVaas[vm.hash] = true;

        _onlyAuthorizedEmitter(vm.emitterChainId, vm.emitterAddress);
        _processMessage(vm.payload);
    }

    // ─── Internal ───────────────────────────────────────────────

    function _onlyOwner() internal view {
        if (msg.sender != owner) revert NotOwner();
    }

    function _onlyAuthorizedEmitter(uint16 sourceChain, bytes32 sourceAddress) internal view {
        if (authorizedEmitters[sourceChain] != sourceAddress) revert NotAuthorizedEmitter();
    }

    function _processMessage(bytes memory payload) internal virtual {
        (string memory message) = abi.decode(payload, (string));
        emit MessageReceived(message);
    }

    // ─── Upgrade ────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view virtual override {
        _onlyOwner();
    }

    // ─── Admin ──────────────────────────────────────────────────

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    function setAuthorizedEmitter(uint16 sourceChain, bytes32 sourceAddress) public onlyOwner {
        authorizedEmitters[sourceChain] = sourceAddress;
    }
}
