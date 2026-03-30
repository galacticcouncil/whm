// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {MessageReceiver} from "../src/MessageReceiver.sol";
import {MessageDispatcher} from "../src/MessageDispatcher.sol";
import {MockWormhole} from "./mocks/MockWormhole.sol";

contract MockTransactor {
    address public lastTarget;
    bytes public lastInput;
    uint256 public callCount;

    function transact(address target, bytes calldata input) external {
        lastTarget = target;
        lastInput = input;
        callCount++;
    }
}

contract MessageDispatcherTest is Test, MockWormhole {
    event MessageReceived(uint16 sourceChain, string message);
    event PriceReceived(bytes32 indexed assetId, uint256 price, uint64 timestamp);

    MessageDispatcher public dispatcher;
    address public wormhole = address(this);
    uint16 public sourceChain = 14;
    bytes32 public sourceAddress = bytes32(uint256(0xabc123));

    function setUp() public {
        MessageDispatcher impl = new MessageDispatcher();
        ERC1967Proxy proxy =
            new ERC1967Proxy(address(impl), abi.encodeCall(MessageDispatcher.initialize, (wormhole)));
        dispatcher = MessageDispatcher(address(proxy));
        dispatcher.setAuthorizedEmitter(sourceChain, sourceAddress);
    }

    // ─── Helpers ─────────────────────────────────────────────────

    function _buildVaa(bytes memory payload) internal view returns (bytes memory) {
        return abi.encode(sourceChain, sourceAddress, payload);
    }

    function _buildVaaWithHash(bytes memory payload, bytes32 salt) internal view returns (bytes memory) {
        return abi.encode(sourceChain, sourceAddress, payload, salt);
    }

    // ─── Tests ───────────────────────────────────────────────────

    function testRoutesPriceUpdate() public {
        bytes32 assetId = keccak256("PRIME");
        uint256 price = 1_234_000_000_000_000_000;
        uint64 timestamp = uint64(block.timestamp);
        MockTransactor transactor = new MockTransactor();

        dispatcher.setHandler(1, address(transactor));
        dispatcher.setOracle(assetId, address(0xBEEF));

        bytes memory payload = abi.encode(uint8(1), assetId, price, timestamp);

        dispatcher.receiveMessage(_buildVaa(payload));

        (uint256 storedPrice, uint64 storedTimestamp, uint64 receivedAt) = dispatcher.latestPrices(assetId);
        assertEq(storedPrice, price);
        assertEq(storedTimestamp, timestamp);
        assertEq(receivedAt, uint64(block.timestamp));
    }

    function testRoutesDefaultMessage() public {
        string memory message = "hello hydration";

        vm.expectEmit(address(dispatcher));
        emit MessageReceived(sourceChain, message);

        bytes memory payload = abi.encode(message, address(0xBEEF));

        dispatcher.receiveMessage(_buildVaa(payload));
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
        vm.expectRevert(MessageReceiver.NotOwner.selector);
        dispatcher.setHandler(1, address(0xCAFE));
    }

    function testOnlyOwnerCanSetOracle() public {
        vm.prank(address(0xdead));
        vm.expectRevert(MessageReceiver.NotOwner.selector);
        dispatcher.setOracle(keccak256("PRIME"), address(0xBEEF));
    }

    function testForwardsScaledPriceToOracle() public {
        MockTransactor transactor = new MockTransactor();
        bytes32 assetId = keccak256("PRIME");
        address oracle = address(0xBEEF);
        uint256 priceWith18Decimals = 1_016_434_800_000_000_000; // 1.0164348 * 1e18
        uint64 timestamp = uint64(block.timestamp);

        dispatcher.setHandler(1, address(transactor));
        dispatcher.setOracle(assetId, oracle);

        bytes memory payload = abi.encode(uint8(1), assetId, priceWith18Decimals, timestamp);

        dispatcher.receiveMessage(_buildVaa(payload));

        assertEq(transactor.callCount(), 1);
        assertEq(transactor.lastTarget(), oracle);
        assertEq(
            transactor.lastInput(),
            abi.encodeWithSignature("setPrice(int256)", int256(uint256(101_643_480)))
        );
    }

    function testRejectsReplayInReceiveMessage() public {
        bytes memory payload = abi.encode("hello hydration");
        bytes memory vaa = _buildVaa(payload);

        dispatcher.receiveMessage(vaa);

        vm.expectRevert("VAA already processed");
        dispatcher.receiveMessage(vaa);
    }

    function testRejectsOlderPriceUpdate() public {
        MockTransactor transactor = new MockTransactor();
        bytes32 assetId = keccak256("PRIME");
        dispatcher.setHandler(1, address(transactor));
        dispatcher.setOracle(assetId, address(0xBEEF));

        uint64 ts = uint64(block.timestamp);
        bytes memory newerPayload = abi.encode(uint8(1), assetId, uint256(2_000_000_000_000_000_000), ts);
        bytes memory olderPayload = abi.encode(uint8(1), assetId, uint256(1_000_000_000_000_000_000), ts - 1);

        dispatcher.receiveMessage(_buildVaa(newerPayload));

        vm.expectRevert(
            abi.encodeWithSelector(MessageDispatcher.StalePriceUpdate.selector, assetId, ts - 1, ts)
        );
        // forge-lint: disable-next-line(unsafe-typecast)
        dispatcher.receiveMessage(_buildVaaWithHash(olderPayload, bytes32("salt")));
    }

}
