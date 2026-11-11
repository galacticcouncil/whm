// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {NttPayload} from "../../src/ntt/NttPayload.sol";
import {IntentCodec} from "../../src/intents/IntentCodec.sol";
import {IntentForwarder} from "../../src/intents/IntentForwarder.sol";
import {IIntentForwarder} from "../../src/intents/interfaces/IIntentForwarder.sol";

import {MockWormhole, MockTransceiver, RejectsEth} from "./IntentReceiverTest.sol";

/// @dev `transferOf` is a library: its reverts need a call frame for `expectRevert` to catch.
contract NttPayloadHarness {
    function transferOf(bytes memory payload) external pure returns (NttPayload.Transfer memory) {
        return NttPayload.transferOf(payload);
    }
}

/// @title IntentForwarderTest
/// @notice Pins what carries intents v2's last hop on Ethereum:
///
///           1. only the dispatcher's transfers to this contract, from Hydration, are orders — the
///              destination comes from a payload NTT attests with the transfer, never the caller;
///           2. a settlement forwards once, and only after its funds were released here;
///           3. the relayer takes at most the payload's ceiling.
contract IntentForwarderTest is Test {
    uint16 constant HYDRATION_CHAIN = 73;
    uint256 constant AMOUNT = 1 ether;
    uint8 constant NTT_DECIMALS = 8;
    uint256 constant TRIM_UNIT = 1e10;
    uint256 constant MAX_RELAY_FEE = 0.01 ether;
    uint64 constant SEQUENCE = 7;

    IntentForwarder public forwarder;
    MockWormhole public wormhole;
    MockTransceiver public transceiver;
    NttPayloadHarness public parser;

    bytes32 public dispatcher = bytes32(uint256(uint160(makeAddr("dispatcher"))));
    address public depositAddress = makeAddr("depositAddress");
    address public relayer = makeAddr("relayer");

    function setUp() public {
        wormhole = new MockWormhole();
        transceiver = new MockTransceiver();
        parser = new NttPayloadHarness();

        forwarder = IntentForwarder(
            payable(
                address(
                    new ERC1967Proxy(
                        address(new IntentForwarder()),
                        abi.encodeCall(IntentForwarder.initialize, (address(wormhole), address(transceiver)))
                    )
                )
            )
        );
        forwarder.setDispatcher(dispatcher);

        transceiver.configure(address(forwarder), AMOUNT);
        vm.deal(address(transceiver), 100 ether);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    struct Settlement {
        uint16 chainId;
        uint64 sequence;
        bytes32 sender;
        bytes32 to;
        uint8 decimals;
        uint256 amount;
        bytes additionalPayload;
    }

    function _order() internal view returns (Settlement memory) {
        return Settlement({
            chainId: HYDRATION_CHAIN,
            sequence: SEQUENCE,
            sender: dispatcher,
            to: bytes32(uint256(uint160(address(forwarder)))),
            decimals: NTT_DECIMALS,
            amount: AMOUNT,
            additionalPayload: abi.encodePacked(uint8(1), depositAddress, uint128(MAX_RELAY_FEE))
        });
    }

    /// @dev A settlement in the transceiver's wire format, its transfer carrying the payload as
    ///      `NttManagerWithPayload` attaches it: `… ‖ toChain ‖ len ‖ payload`, the length and payload
    ///      present only when the payload is non-empty.
    function _payload(Settlement memory s) internal pure returns (bytes memory) {
        bytes memory transfer = abi.encodePacked(
            NttPayload.NTT_PREFIX,
            s.decimals,
            uint64(s.amount / TRIM_UNIT),
            bytes32(uint256(4)), // sourceToken
            s.to,
            uint16(2) // toChain
        );
        if (s.additionalPayload.length > 0) {
            transfer = abi.encodePacked(transfer, uint16(s.additionalPayload.length), s.additionalPayload);
        }
        bytes memory managerMessage =
            abi.encodePacked(bytes32(uint256(s.sequence)), s.sender, uint16(transfer.length), transfer);
        return abi.encodePacked(
            NttPayload.WH_TRANSCEIVER_PAYLOAD_PREFIX,
            bytes32(uint256(1)), // sourceNttManagerAddress
            bytes32(uint256(2)), // recipientNttManagerAddress
            uint16(managerMessage.length),
            managerMessage,
            uint16(0) // transceiverPayload length
        );
    }

    function _vaa(Settlement memory s) internal view returns (bytes memory) {
        return abi.encode(s.chainId, bytes32(uint256(9)), uint32(block.timestamp), s.sequence, _payload(s));
    }

    // ─── Forward ────────────────────────────────────────────────────

    function testDeliversAndForwards() public {
        vm.expectEmit(true, true, false, true, address(forwarder));
        emit IIntentForwarder.OrderForwarded(SEQUENCE, depositAddress, AMOUNT);
        vm.prank(relayer);
        forwarder.processOrder(_vaa(_order()), 0);

        assertEq(depositAddress.balance, AMOUNT, "whole amount forwarded");
        assertEq(address(forwarder).balance, 0, "nothing left over");
    }

    function testPaysTheRelayerUpToTheCeiling() public {
        vm.prank(relayer);
        forwarder.processOrder(_vaa(_order()), MAX_RELAY_FEE);

        assertEq(relayer.balance, MAX_RELAY_FEE, "fee");
        assertEq(depositAddress.balance, AMOUNT - MAX_RELAY_FEE, "the rest");
    }

    function testFeeAboveTheCeilingReverts() public {
        bytes memory vaa = _vaa(_order());
        vm.prank(relayer);
        vm.expectRevert(IIntentForwarder.FeeExceedsCeiling.selector);
        forwarder.processOrder(vaa, MAX_RELAY_FEE + 1);
    }

    /// @notice A third party delivering first is ordinary, not a denial of service.
    function testForwardsAnAlreadyDeliveredSettlement() public {
        bytes memory vaa = _vaa(_order());
        transceiver.receiveMessage(vaa);
        assertEq(address(forwarder).balance, AMOUNT, "released before processing");

        forwarder.processOrder(vaa, 0);
        assertEq(depositAddress.balance, AMOUNT);
    }

    function testForwardsOnce() public {
        bytes memory vaa = _vaa(_order());
        forwarder.processOrder(vaa, 0);
        vm.expectRevert(IIntentForwarder.AlreadyRedeemed.selector);
        forwarder.processOrder(vaa, 0);
    }

    // ─── Only the dispatcher's orders ───────────────────────────────

    /// @notice Anyone can make a WETH transfer with a payload; only the dispatcher's is an order.
    function testRejectsAnotherSendersTransfer() public {
        Settlement memory s = _order();
        s.sender = bytes32(uint256(uint160(makeAddr("attacker"))));
        bytes memory vaa = _vaa(s);
        vm.expectRevert(abi.encodeWithSelector(IIntentForwarder.UnauthorizedSender.selector, s.sender));
        forwarder.processOrder(vaa, 0);
    }

    function testRejectsAnotherSourceChain() public {
        Settlement memory s = _order();
        s.chainId = 30;
        bytes memory vaa = _vaa(s);
        vm.expectRevert(abi.encodeWithSelector(IIntentForwarder.UnexpectedSourceChain.selector, uint16(30)));
        forwarder.processOrder(vaa, 0);
    }

    /// @notice A transfer released to another address would be forwarded out of this contract's
    ///         balance — e.g. one the dispatcher sent to a previous forwarder.
    function testRejectsATransferToAnotherRecipient() public {
        Settlement memory s = _order();
        s.to = bytes32(uint256(uint160(makeAddr("oldForwarder"))));
        bytes memory vaa = _vaa(s);
        vm.expectRevert(abi.encodeWithSelector(IIntentForwarder.WrongRecipient.selector, s.to));
        forwarder.processOrder(vaa, 0);
    }

    function testRejectsAMissingOrMalformedPayload() public {
        Settlement memory s = _order();
        s.additionalPayload = "";
        bytes memory vaa = _vaa(s);
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.MalformedForward.selector, 0));
        forwarder.processOrder(vaa, 0);

        s.additionalPayload = abi.encodePacked(uint8(2), depositAddress, uint128(MAX_RELAY_FEE));
        vaa = _vaa(s);
        vm.expectRevert(abi.encodeWithSelector(IntentCodec.MalformedForward.selector, 37));
        forwarder.processOrder(vaa, 0);
    }

    function testRejectsAnUnexpectedTrim() public {
        Settlement memory s = _order();
        s.decimals = 6;
        bytes memory vaa = _vaa(s);
        vm.expectRevert(abi.encodeWithSelector(IIntentForwarder.UnexpectedTrim.selector, uint8(6)));
        forwarder.processOrder(vaa, 0);
    }

    // ─── Released, not just delivered ───────────────────────────────

    /// @notice A transfer held by the inbound rate limiter released nothing; the order stays
    ///         executable for when it does.
    function testQueuedSettlementIsNotForwarded() public {
        bytes memory vaa = _vaa(_order());
        transceiver.receiveMessage(vaa);
        transceiver.enqueue(vaa);

        vm.expectRevert(abi.encodeWithSelector(IIntentForwarder.SettlementNotReleased.selector, SEQUENCE));
        forwarder.processOrder(vaa, 0);
        assertFalse(forwarder.processed(keccak256(abi.encodePacked(HYDRATION_CHAIN, _message()))), "retryable");
    }

    function _message() internal view returns (bytes memory) {
        return parser.transferOf(_payload(_order())).message;
    }

    function testRejectedForwardReverts() public {
        Settlement memory s = _order();
        s.additionalPayload = abi.encodePacked(uint8(1), address(new RejectsEth()), uint128(0));
        bytes memory vaa = _vaa(s);
        vm.expectRevert(IIntentForwarder.NativeTransferFailed.selector);
        forwarder.processOrder(vaa, 0);
    }

    // ─── Exclusive window ───────────────────────────────────────────

    function testExclusiveWindowThenOpen() public {
        forwarder.setAuthorizedRelayer(relayer, true);
        bytes memory vaa = _vaa(_order());

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(IIntentForwarder.Unauthorized.selector);
        forwarder.processOrder(vaa, 0);

        vm.warp(block.timestamp + 5 minutes);
        vm.prank(makeAddr("stranger"));
        forwarder.processOrder(vaa, 0);
        assertEq(depositAddress.balance, AMOUNT);
    }

    // ─── Parsing ────────────────────────────────────────────────────

    function testTransferOfReadsTheWholeTransfer() public view {
        NttPayload.Transfer memory t = parser.transferOf(_payload(_order()));
        assertEq(t.sequence, SEQUENCE);
        assertEq(t.sender, dispatcher);
        assertEq(t.to, bytes32(uint256(uint160(address(forwarder)))));
        assertEq(t.toChain, 2);
        assertEq(t.decimals, NTT_DECIMALS);
        assertEq(uint256(t.amount) * TRIM_UNIT, AMOUNT);
        assertEq(t.additionalPayload, abi.encodePacked(uint8(1), depositAddress, uint128(MAX_RELAY_FEE)));

        Settlement memory s = _order();
        s.additionalPayload = "";
        assertEq(parser.transferOf(_payload(s)).additionalPayload.length, 0, "no payload, none read");
    }

    /// @notice The manager message must end where the transfer does — trailing bytes are not
    ///         ignored.
    function testTransferOfRejectsTrailingBytes() public {
        bytes memory payload = _payload(_order());
        // Grow the manager message's declared length by one and append a byte inside it.
        bytes memory messageLength = abi.encodePacked(uint16(uint8(payload[68]) * 256 + uint8(payload[69]) + 1));
        payload[68] = messageLength[0];
        payload[69] = messageLength[1];
        bytes memory grown = new bytes(payload.length + 1);
        for (uint256 i = 0; i < payload.length - 2; i++) {
            grown[i] = payload[i];
        }
        vm.expectRevert();
        parser.transferOf(grown);
    }

    // ─── Admin ──────────────────────────────────────────────────────

    function testUnconfiguredForwarderProcessesNothing() public {
        forwarder.setDispatcher(bytes32(0));
        bytes memory vaa = _vaa(_order());
        vm.expectRevert(IIntentForwarder.NotConfigured.selector);
        forwarder.processOrder(vaa, 0);
    }

    function testOnlyTheOwnerConfigures() public {
        vm.startPrank(relayer);
        vm.expectRevert(IIntentForwarder.NotOwner.selector);
        forwarder.setDispatcher(bytes32(uint256(1)));
        vm.expectRevert(IIntentForwarder.NotOwner.selector);
        forwarder.setAuthorizedRelayer(relayer, true);
        vm.expectRevert(IIntentForwarder.NotOwner.selector);
        forwarder.sweep(relayer, 1);
        vm.stopPrank();

        address impl = address(new IntentForwarder());
        vm.prank(relayer);
        vm.expectRevert(IIntentForwarder.NotOwner.selector);
        forwarder.upgradeToAndCall(impl, "");
    }
}
