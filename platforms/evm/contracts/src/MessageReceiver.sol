// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IWormholeRelayer} from "wormhole-solidity-sdk/interfaces/IWormholeRelayer.sol";
import {IWormholeReceiver} from "wormhole-solidity-sdk/interfaces/IWormholeReceiver.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

contract MessageReceiver is Initializable, UUPSUpgradeable, IWormholeReceiver {
    IWormholeRelayer public wormholeRelayer;
    IWormhole public wormhole;

    address public owner;
    mapping(address => bool) public authorized;

    mapping(uint16 => bytes32) public registeredEmitters;
    mapping(bytes32 => bool) public processedVaas;

    event MessageReceived(string message);

    error NotOwner();
    error NotAuthorized();
    error NotRegisteredEmitter();

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    modifier onlyAuthorized() {
        _onlyAuthorized();
        _;
    }

    modifier onlyRegisteredEmitter(uint16 sourceChain, bytes32 sourceAddress) {
        _onlyRegisteredEmitter(sourceChain, sourceAddress);
        _;
    }

    constructor() {
        _disableInitializers();
    }

    function initialize(address _wormholeRelayer, address _wormhole) public virtual initializer {
        _initMessageReceiver(_wormholeRelayer, _wormhole);
    }

    function _initMessageReceiver(address _wormholeRelayer, address _wormhole) internal onlyInitializing {
        wormholeRelayer = IWormholeRelayer(_wormholeRelayer);
        wormhole = IWormhole(_wormhole);
        owner = msg.sender;
    }

    // ─── Receive ────────────────────────────────────────────────

    function receiveWormholeMessages(
        bytes memory payload,
        bytes[] memory,
        bytes32 sourceAddress,
        uint16 sourceChain,
        bytes32
    ) public payable override onlyRegisteredEmitter(sourceChain, sourceAddress) {
        require(msg.sender == address(wormholeRelayer), "Only the Wormhole relayer can call this function");
        _processMessage(payload);
    }

    function receiveMessage(bytes memory vaa) public onlyAuthorized {
        (IWormhole.VM memory vm, bool valid, string memory reason) = wormhole.parseAndVerifyVM(vaa);
        require(valid, reason);

        require(!processedVaas[vm.hash], "VAA already processed");
        processedVaas[vm.hash] = true;

        _onlyRegisteredEmitter(vm.emitterChainId, vm.emitterAddress);
        _processMessage(vm.payload);
    }

    // ─── Internal ───────────────────────────────────────────────

    function _onlyOwner() internal view {
        if (msg.sender != owner) revert NotOwner();
    }

    function _onlyAuthorized() internal view {
        if (!authorized[msg.sender]) revert NotAuthorized();
    }

    function _onlyRegisteredEmitter(uint16 sourceChain, bytes32 sourceAddress) internal view {
        if (registeredEmitters[sourceChain] != sourceAddress) revert NotRegisteredEmitter();
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

    function setAuthorized(address addr, bool enabled) public onlyOwner {
        authorized[addr] = enabled;
    }

    function setRegisteredEmitter(uint16 sourceChain, bytes32 sourceAddress) public onlyOwner {
        registeredEmitters[sourceChain] = sourceAddress;
    }
}
