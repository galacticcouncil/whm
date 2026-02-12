// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IWormholeRelayer} from "wormhole-solidity-sdk/interfaces/IWormholeRelayer.sol";
import {IWormholeReceiver} from "wormhole-solidity-sdk/interfaces/IWormholeReceiver.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

contract MessageReceiver is IWormholeReceiver {
    IWormholeRelayer public wormholeRelayer;
    IWormhole public wormhole;
    address public registrationOwner;

    // Registered senders for each chain
    mapping(uint16 => bytes32) public registeredSenders;

    // Registered updaters (bots) that can submit VAAs
    mapping(address => bool) public registeredUpdaters;

    // Processed VAA hashes to prevent replay
    mapping(bytes32 => bool) public processedVaas;

    event MessageReceived(string message);

    constructor(address _wormholeRelayer, address _wormhole) {
        wormholeRelayer = IWormholeRelayer(_wormholeRelayer);
        wormhole = IWormhole(_wormhole);
        registrationOwner = msg.sender;
    }

    modifier isRegisteredSender(uint16 sourceChain, bytes32 sourceAddress) {
        _isRegisteredSender(sourceChain, sourceAddress);
        _;
    }

    modifier isRegisteredUpdater() {
        _isRegisteredUpdater();
        _;
    }

    function _isRegisteredSender(uint16 sourceChain, bytes32 sourceAddress) internal view {
        require(registeredSenders[sourceChain] == sourceAddress, "Not registered sender");
    }

    function _isRegisteredUpdater() internal view {
        require(registeredUpdaters[msg.sender], "Not registered updater");
    }

    function _processMessage(bytes memory payload) internal virtual {
        (string memory message) = abi.decode(payload, (string));
        emit MessageReceived(message);
    }

    function setRegisteredSender(uint16 sourceChain, bytes32 sourceAddress) public {
        require(msg.sender == registrationOwner, "Not allowed to set registered sender");
        registeredSenders[sourceChain] = sourceAddress;
    }

    function setRegisteredUpdater(address updater, bool enabled) public {
        require(msg.sender == registrationOwner, "Not allowed to set registered updater");
        registeredUpdaters[updater] = enabled;
    }

    // Receive a message via Relayer
    function receiveWormholeMessages(
        bytes memory payload,
        bytes[] memory,
        bytes32 sourceAddress,
        uint16 sourceChain,
        bytes32
    ) public payable override isRegisteredSender(sourceChain, sourceAddress) {
        require(msg.sender == address(wormholeRelayer), "Only the Wormhole relayer can call this function");
        _processMessage(payload);
    }

    // Receive a message via Core Bridge (for non-EVM chains)
    function receiveMessage(bytes memory vaa) public isRegisteredUpdater {
        (IWormhole.VM memory vm, bool valid, string memory reason) = wormhole.parseAndVerifyVM(vaa);
        require(valid, reason);

        require(!processedVaas[vm.hash], "VAA already processed");
        processedVaas[vm.hash] = true;

        _isRegisteredSender(vm.emitterChainId, vm.emitterAddress);
        _processMessage(vm.payload);
    }
}
