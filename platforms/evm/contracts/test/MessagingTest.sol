// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {MessageEmitter} from "../src/MessageEmitter.sol";
import {MessageDispatcher} from "../src/MessageDispatcher.sol";
import {MockWormhole} from "./mocks/MockWormhole.sol";

contract MessagingTest is Test, MockWormhole {
    MessageEmitter public emitterContract;
    MessageDispatcher public receiverContract;
    address public wormhole = address(this);

    function setUp() public {
        MessageEmitter emitterImpl = new MessageEmitter();
        ERC1967Proxy emitterProxy = new ERC1967Proxy(
            address(emitterImpl),
            abi.encodeCall(MessageEmitter.initialize, (wormhole))
        );
        emitterContract = MessageEmitter(address(emitterProxy));

        MessageDispatcher receiverImpl = new MessageDispatcher();
        ERC1967Proxy receiverProxy = new ERC1967Proxy(
            address(receiverImpl),
            abi.encodeCall(MessageDispatcher.initialize, (wormhole))
        );
        receiverContract = MessageDispatcher(address(receiverProxy));
    }

    function testDeployment() public view {
        assertEq(address(emitterContract).code.length > 0, true);
        assertEq(address(receiverContract).code.length > 0, true);
    }

    function testSendMessage() public {
        string memory message = "Hello from Moonbeam to Base!";

        uint256 estimatedCost = 1 ether;
        vm.deal(address(this), estimatedCost);

        vm.expectRevert();
        emitterContract.sendMessage{value: estimatedCost}(message);
    }

    function testReceiveMessage() public {
        uint16 sourceChain = 14;
        bytes32 sourceAddr = bytes32(uint256(uint160(address(this))));
        receiverContract.setAuthorizedEmitter(sourceChain, sourceAddr);

        string memory message = "Hello from Moonbeam to Base!";
        bytes memory payload = abi.encode(message);
        bytes memory vaa = abi.encode(sourceChain, sourceAddr, payload);

        receiverContract.receiveMessage(vaa);
    }

}
