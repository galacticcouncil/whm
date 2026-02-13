// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {MessageDispatcher} from "../src/MessageDispatcher.sol";

contract MessageDispatcherTest is Test {
    event MessageReceived(string message);
    event PriceReceived(bytes32 indexed assetId, uint256 price, uint64 timestamp);

    MessageDispatcher public dispatcher;
    address public wormholeRelayer = address(this);
    address public wormhole = address(this);
    uint16 public sourceChain = 14;
    bytes32 public sourceAddress = bytes32(uint256(0xabc123));

    function setUp() public {
        dispatcher = new MessageDispatcher(wormholeRelayer, wormhole);
        dispatcher.setRegisteredSender(sourceChain, sourceAddress);
    }

    function testRoutesPriceUpdate() public {
        bytes32 assetId = keccak256("PRIME");
        uint256 price = 1_234_000_000_000_000_000;
        uint64 timestamp = 1_739_355_200;

        bytes memory payload = abi.encode(uint8(1), assetId, price, timestamp);

        vm.prank(wormholeRelayer);
        dispatcher.receiveWormholeMessages(payload, new bytes[](0), sourceAddress, sourceChain, bytes32(0));

        (uint256 storedPrice, uint64 storedTimestamp, uint64 receivedAt) = dispatcher.latestPrices(assetId);
        assertEq(storedPrice, price);
        assertEq(storedTimestamp, timestamp);
        assertEq(receivedAt, uint64(block.timestamp));
    }

    function testRoutesDefaultMessage() public {
        string memory message = "hello hydration";

        vm.expectEmit(address(dispatcher));
        emit MessageReceived(message);

        bytes memory payload = abi.encode(message, address(0xBEEF));

        vm.prank(wormholeRelayer);
        dispatcher.receiveWormholeMessages(payload, new bytes[](0), sourceAddress, sourceChain, bytes32(0));
    }

    function testSetHandler() public {
        dispatcher.setHandler(1, address(0xCAFE));
        assertEq(dispatcher.handlers(1), address(0xCAFE));
    }

    function testSetOracle() public {
        bytes32 assetId = keccak256("PRIME");
        dispatcher.setOracle(assetId, address(0xBEEF));
        assertEq(dispatcher.oracles(assetId), address(0xBEEF));
    }

    function testOnlyOwnerCanSetHandler() public {
        vm.prank(address(0xdead));
        vm.expectRevert("Not allowed");
        dispatcher.setHandler(1, address(0xCAFE));
    }

    function testOnlyOwnerCanSetOracle() public {
        vm.prank(address(0xdead));
        vm.expectRevert("Not allowed");
        dispatcher.setOracle(keccak256("PRIME"), address(0xBEEF));
    }
}
