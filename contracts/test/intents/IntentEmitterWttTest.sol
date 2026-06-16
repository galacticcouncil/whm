// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {IntentEmitterWtt} from "../../src/intents/IntentEmitterWtt.sol";
import {IntentEmitterBjp} from "../../src/intents/IntentEmitterBjp.sol";

/// @dev Expose the internal payload encoder of each variant. `_encodePayload` is pure, so no
///      initialization is needed — the harness is deployed and called directly.
contract WttHarness is IntentEmitterWtt {
    function encodePayload(bytes32 id, address dest, uint256 maxRelayFee) external pure returns (bytes memory) {
        return _encodePayload(id, dest, maxRelayFee);
    }
}

contract BjpHarness is IntentEmitterBjp {
    function encodePayload(bytes32 id, address dest, uint256 maxRelayFee) external pure returns (bytes memory) {
        return _encodePayload(id, dest, maxRelayFee);
    }
}

contract IntentEmitterWttTest is Test {
    WttHarness public wtt;
    BjpHarness public bjp;

    bytes32 constant INTENT_ID = keccak256("intent-1");
    address constant DEPOSIT = 0x000000000000000000000000000000000000dEaD;
    uint256 constant MAX_RELAY_FEE = 0.5 ether;

    function setUp() public {
        wtt = new WttHarness();
        bjp = new BjpHarness();
    }

    /// @dev WTT payload is the 96-byte (intentId, depositAddress, maxRelayFee) the receiver decodes.
    function testWttPayloadCarriesMaxRelayFee() public view {
        bytes memory payload = wtt.encodePayload(INTENT_ID, DEPOSIT, MAX_RELAY_FEE);
        assertEq(payload.length, 96, "96-byte payload");

        // Round-trips exactly as IntentReceiver.redeem decodes it.
        (bytes32 id, address dest, uint256 fee) = abi.decode(payload, (bytes32, address, uint256));
        assertEq(id, INTENT_ID);
        assertEq(dest, DEPOSIT);
        assertEq(fee, MAX_RELAY_FEE);
    }

    /// @dev BJP keeps the 64-byte (intentId, depositAddress) format — IntentRouter is unchanged.
    function testBjpPayloadIgnoresMaxRelayFee() public view {
        bytes memory payload = bjp.encodePayload(INTENT_ID, DEPOSIT, MAX_RELAY_FEE);
        assertEq(payload.length, 64, "64-byte payload");

        (bytes32 id, address dest) = abi.decode(payload, (bytes32, address));
        assertEq(id, INTENT_ID);
        assertEq(dest, DEPOSIT);
    }
}
