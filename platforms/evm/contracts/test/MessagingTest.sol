// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {MessageRelayer} from "../src/MessageRelayer.sol";
import {MessageDispatcher} from "../src/MessageDispatcher.sol";

contract MessagingTest is Test {
    MessageRelayer public senderContract;
    MessageDispatcher public receiverContract;
    address public wormholeRelayer = address(this);
    address public wormhole = address(this);

    function setUp() public {
        senderContract = new MessageRelayer(wormholeRelayer);
        MessageDispatcher impl = new MessageDispatcher();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(MessageDispatcher.initialize, (wormholeRelayer, wormhole))
        );
        receiverContract = MessageDispatcher(address(proxy));
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
