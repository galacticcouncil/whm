// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {AggregatorAdapter} from "../../../src/oracles/adapters/AggregatorAdapter.sol";
import {OracleEmitter} from "../../../src/oracles/OracleEmitter.sol";

/// @dev Mirrors Hydration's EMA oracle precompile: answer + decimals only, no rounds.
contract MockAnswerSource {
    uint8 public decimals;
    int256 public latestAnswer;

    constructor(uint8 d, int256 a) {
        decimals = d;
        latestAnswer = a;
    }

    function set(int256 a) external {
        latestAnswer = a;
    }

    function setDecimals(uint8 d) external {
        decimals = d;
    }
}

contract RevertingSource {
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function latestAnswer() external pure returns (int256) {
        revert("Price not available");
    }
}

contract AggregatorAdapterTest is Test {
    AggregatorAdapter public adapter;
    MockAnswerSource public src;

    int256 constant HDX_8DEC = 693273; // 0.00693273 USDT per HDX (10m EMA)

    bytes public lastPayload;

    function setUp() public {
        src = new MockAnswerSource(8, HDX_8DEC);
        adapter = new AggregatorAdapter(address(src));
    }

    // ─── Init ────────────────────────────────────────────────────

    function testDeployment() public view {
        assertEq(address(adapter.feed()), address(src));
    }

    function testZeroSourceReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AggregatorAdapter.InvalidFeed.selector, address(0)));
        new AggregatorAdapter(address(0));
    }

    // ─── Scaling ─────────────────────────────────────────────────

    function testScales8DecTo18Dec() public view {
        assertEq(adapter.latestRate(), uint256(HDX_8DEC) * 1e10);
    }

    function testScales18DecUnchanged() public {
        src.setDecimals(18);
        src.set(1.5e18);
        assertEq(adapter.latestRate(), 1.5e18);
    }

    function testDecimalsReadPerCall() public {
        src.setDecimals(6);
        src.set(6_932);
        assertEq(adapter.latestRate(), 6_932 * 1e12);
    }

    function testDecimalsAbove18Revert() public {
        src.setDecimals(19);
        vm.expectRevert(abi.encodeWithSelector(AggregatorAdapter.UnsupportedDecimals.selector, uint8(19)));
        adapter.latestRate();
    }

    // ─── Answer checks ───────────────────────────────────────────

    function testZeroAnswerReverts() public {
        src.set(0);
        vm.expectRevert(abi.encodeWithSelector(AggregatorAdapter.InvalidAnswer.selector, int256(0)));
        adapter.latestRate();
    }

    function testNegativeAnswerReverts() public {
        src.set(-1);
        vm.expectRevert(abi.encodeWithSelector(AggregatorAdapter.InvalidAnswer.selector, int256(-1)));
        adapter.latestRate();
    }

    function testSourceRevertBubbles() public {
        AggregatorAdapter dead = new AggregatorAdapter(address(new RevertingSource()));
        vm.expectRevert("Price not available");
        dead.latestRate();
    }

    // ─── Through OracleEmitter ───────────────────────────────────

    function messageFee() external pure returns (uint256) {
        return 0;
    }

    function publishMessage(uint32, bytes memory payload, uint8) external payable returns (uint64) {
        lastPayload = payload;
        return 1;
    }

    function _emitter() internal returns (OracleEmitter emitter) {
        OracleEmitter impl = new OracleEmitter();
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), abi.encodeCall(OracleEmitter.initialize, (address(this))));
        emitter = OracleEmitter(address(proxy));
        emitter.registerFeed(keccak256("HDX"), address(adapter), abi.encodeCall(AggregatorAdapter.latestRate, ()));
    }

    function testEmitterPublishesReceiverScalableRate() public {
        OracleEmitter emitter = _emitter();
        emitter.send(keccak256("HDX"));

        (uint8 action, bytes32 assetId, uint256 rate,) = abi.decode(lastPayload, (uint8, bytes32, uint256, uint64));
        assertEq(action, 2);
        assertEq(assetId, keccak256("HDX"));
        // OracleReceiver divides by 1e10 — must land back on the source's 8-dec answer.
        assertEq(rate / 1e10, uint256(HDX_8DEC));
    }

    function testEmitterSurfacesSourceRevert() public {
        OracleEmitter emitter = _emitter();
        src.set(0);
        vm.expectRevert();
        emitter.send(keccak256("HDX"));
    }
}
