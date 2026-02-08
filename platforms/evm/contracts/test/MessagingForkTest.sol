// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {WormholeRelayerBasicTest} from "wormhole-solidity-sdk/testing/WormholeRelayerTest.sol";
import {toWormholeFormat} from "wormhole-solidity-sdk/Utils.sol";
import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";

import {MessageSender} from "../src/MessageSender.sol";
import {MessageReceiver} from "../src/MessageReceiver.sol";

contract MessagingForkTest is WormholeRelayerBasicTest {
    MessageSender public senderSource;
    MessageReceiver public receiverTarget;

    constructor() WormholeRelayerBasicTest() {
        // Moonbeam (16) -> Base (30) on mainnet forks
        setMainnetForkChains(16, 30);
    }

    function setUpSource() public override {
        senderSource = new MessageSender(address(relayerSource));
    }

    function setUpTarget() public override {
        receiverTarget = new MessageReceiver(address(relayerTarget));
    }

    function setUpGeneral() public override {
        vm.selectFork(targetFork);
        receiverTarget.setRegisteredSender(sourceChain, toWormholeFormat(address(senderSource)));
    }

    function testSendMessageEndToEndFork() public {
        string memory message = "Hello from forked test!";

        // Run the send on the source fork (Moonbeam).
        vm.selectFork(sourceFork);

        uint256 cost = senderSource.quoteCrossChainCost(targetChain);
        console.log("sourceChain", sourceChain);
        console.log("targetChain", targetChain);
        console.log("cost", cost);
        console.log("senderSource", address(senderSource));
        console.log("receiverTarget", address(receiverTarget));
        vm.deal(address(this), cost);

        // Capture relayer logs emitted on the source fork.
        vm.recordLogs();
        senderSource.sendMessage{value: cost}(targetChain, address(receiverTarget), message);
        Vm.Log[] memory sendLogs = vm.getRecordedLogs();

        // Switch to the target fork (Base) and start recording delivery logs there.
        vm.selectFork(targetFork);
        vm.recordLogs();

        // Switch back to the source fork to execute the offchain relayer delivery.
        vm.selectFork(sourceFork);
        performDelivery(sendLogs);

        // Return to the target fork and collect the logs emitted by the receiver.
        vm.selectFork(targetFork);

        Vm.Log[] memory deliveryLogs = vm.getRecordedLogs();
        console.log("deliveryLogs.length", deliveryLogs.length);

        bytes32 expectedTopic = keccak256("MessageReceived(string)");
        bool found;
        for (uint256 i = 0; i < deliveryLogs.length; i++) {
            if (
                deliveryLogs[i].emitter == address(receiverTarget) && deliveryLogs[i].topics.length > 0
                    && deliveryLogs[i].topics[0] == expectedTopic
            ) {
                string memory decoded = abi.decode(deliveryLogs[i].data, (string));
                console.log("decoded message", decoded);
                require(keccak256(bytes(decoded)) == keccak256(bytes(message)), "Message payload mismatch");
                found = true;
                break;
            }
        }

        require(found, "MessageReceived not found");
    }
}
