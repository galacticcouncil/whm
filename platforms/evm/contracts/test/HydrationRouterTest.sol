// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {HydrationRouter} from "../src/HydrationRouter.sol";

contract HydrationRouterTest is Test {
    event MessageReceived(string message);

    HydrationRouter public router;
    address public wormholeRelayer = address(this);
    address public wormhole = address(this);
    uint16 public sourceChain = 14;
    bytes32 public sourceAddress = bytes32(uint256(0xabc123));

    function setUp() public {
        router = new HydrationRouter(wormholeRelayer, wormhole);
        router.setRegisteredSender(sourceChain, sourceAddress);
    }

    function testRoutesPriceActionInternally() public {
        bytes32 assetId = keccak256("PRIME");
        uint256 price = 1_234_000_000_000_000_000;
        uint64 timestamp = 1_739_355_200;

        bytes memory payload = abi.encode(uint8(1), assetId, price, timestamp);

        vm.prank(wormholeRelayer);
        router.receiveWormholeMessages(payload, new bytes[](0), sourceAddress, sourceChain, bytes32(0));

        (uint256 storedPrice, uint64 storedTimestamp, uint64 receivedAt) = router.latestPrices(assetId);
        assertEq(storedPrice, price);
        assertEq(storedTimestamp, timestamp);
        assertEq(receivedAt, uint64(block.timestamp));
    }

    function testRoutesDefaultMessageInternally() public {
        string memory message = "hello hydration";

        vm.expectEmit(address(router));
        emit MessageReceived(message);

        bytes memory payload = abi.encode(message, address(0xBEEF));

        vm.prank(wormholeRelayer);
        router.receiveWormholeMessages(payload, new bytes[](0), sourceAddress, sourceChain, bytes32(0));
    }
}
