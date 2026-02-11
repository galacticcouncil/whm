// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {MessageRelayer} from "../src/MessageRelayer.sol";
import {MessageReceiver} from "../src/MessageReceiver.sol";

contract MessagingTest is Test {
    MessageRelayer public senderContract;
    MessageReceiver public receiverContract;
    address public wormholeRelayer = address(this);
    address public wormhole = address(this);

    function setUp() public {
        senderContract = new MessageRelayer(wormholeRelayer);
        receiverContract = new MessageReceiver(wormholeRelayer, wormhole);
    }

    function testDeployment() public view {
        assertEq(address(senderContract).code.length > 0, true);
        assertEq(address(receiverContract).code.length > 0, true);
    }

    function testSendMessage() public {
        uint16 targetChain = 30;
        address targetAddress = address(receiverContract);
        string memory message = "Hello from Moonbeam to Base!";

        uint256 estimatedCost = 1 ether;
        vm.deal(address(this), estimatedCost);

        vm.expectRevert();
        senderContract.sendMessage{value: estimatedCost}(targetChain, targetAddress, message);
    }

    function testReceiveMessage() public {
        string memory message = "Hello from Moonbeam to Base!";
        bytes memory payload = abi.encode(message);

        vm.prank(wormholeRelayer);
        receiverContract.receiveWormholeMessages(payload, new bytes[](0), bytes32(0), 14, bytes32(0));
    }
}
