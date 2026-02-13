// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {WormholeRelayerBasicTest} from "wormhole-solidity-sdk/testing/WormholeRelayerTest.sol";
import {toWormholeFormat} from "wormhole-solidity-sdk/Utils.sol";
import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {MessageRelayer} from "../src/MessageRelayer.sol";
import {MessageDispatcher} from "../src/MessageDispatcher.sol";

contract MessagingForkTest is WormholeRelayerBasicTest {
    MessageRelayer public senderSource;
    MessageDispatcher public receiverTarget;

    constructor() WormholeRelayerBasicTest() {
        // Avoid dependency default (Ankr)
        chainInfosMainnet[16].url = vm.envOr("MOOMBEAM_RPC_URL", string("https://rpc.api.moonbeam.network"));
        // Moonbeam (16) -> Base (30) on mainnet forks
        setMainnetForkChains(16, 30);
    }

    function setUpSource() public override {
        senderSource = new MessageRelayer(address(relayerSource));
    }

    function setUpTarget() public override {
        MessageDispatcher impl = new MessageDispatcher();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(MessageDispatcher.initialize, (address(relayerTarget), address(wormholeTarget)))
        );
        receiverTarget = MessageDispatcher(address(proxy));
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
