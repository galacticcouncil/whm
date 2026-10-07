// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {AggregatorV3Adapter} from "../../../src/oracles/adapters/AggregatorV3Adapter.sol";
import {OracleEmitter} from "../../../src/oracles/OracleEmitter.sol";

contract MockAggregator {
    uint8 public decimals;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 d) {
        decimals = d;
    }

    function set(int256 a, uint256 u) external {
        answer = a;
        updatedAt = u;
    }

    function setDecimals(uint8 d) external {
        decimals = d;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract AggregatorV3AdapterTest is Test {
    AggregatorV3Adapter public adapter;
    MockAggregator public agg;

    uint256 constant MAX_AGE = 26 hours;
    int256 constant SPY_8DEC = 78008287704; // $780.08287704

    bytes public lastPayload;

    function setUp() public {
        vm.warp(1_800_000_000);
        agg = new MockAggregator(8);
        agg.set(SPY_8DEC, block.timestamp);
        adapter = new AggregatorV3Adapter(address(agg), MAX_AGE);
    }

    // ─── Init ────────────────────────────────────────────────────

    function testDeployment() public view {
        assertEq(address(adapter.feed()), address(agg));
        assertEq(adapter.maxAge(), MAX_AGE);
    }

    function testZeroFeedReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AggregatorV3Adapter.InvalidFeed.selector, address(0)));
        new AggregatorV3Adapter(address(0), MAX_AGE);
    }

    // ─── Scaling ─────────────────────────────────────────────────

    function testScales8DecTo18Dec() public view {
        assertEq(adapter.latestRate(), uint256(SPY_8DEC) * 1e10);
    }

    function testScales18DecUnchanged() public {
        agg.setDecimals(18);
        agg.set(1.5e18, block.timestamp);
        assertEq(adapter.latestRate(), 1.5e18);
    }

    function testDecimalsReadPerCall() public {
        agg.setDecimals(6);
        agg.set(780_082877, block.timestamp);
        assertEq(adapter.latestRate(), 780_082877 * 1e12);
    }

    function testDecimalsAbove18Revert() public {
        agg.setDecimals(19);
        vm.expectRevert(abi.encodeWithSelector(AggregatorV3Adapter.UnsupportedDecimals.selector, uint8(19)));
        adapter.latestRate();
    }

    // ─── Answer checks ───────────────────────────────────────────

    function testZeroAnswerReverts() public {
        agg.set(0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(AggregatorV3Adapter.InvalidAnswer.selector, int256(0)));
        adapter.latestRate();
    }

    function testNegativeAnswerReverts() public {
        agg.set(-1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(AggregatorV3Adapter.InvalidAnswer.selector, int256(-1)));
        adapter.latestRate();
    }

    // ─── Staleness ───────────────────────────────────────────────

    function testAtMaxAgeIsFresh() public {
        agg.set(SPY_8DEC, block.timestamp - MAX_AGE);
        assertEq(adapter.latestRate(), uint256(SPY_8DEC) * 1e10);
    }

    function testPastMaxAgeReverts() public {
        uint256 updatedAt = block.timestamp - MAX_AGE - 1;
        agg.set(SPY_8DEC, updatedAt);
        vm.expectRevert(abi.encodeWithSelector(AggregatorV3Adapter.StaleAnswer.selector, updatedAt, MAX_AGE));
        adapter.latestRate();
    }

    function testWeekendGapRevertsWithMaxAge() public {
        agg.set(SPY_8DEC, block.timestamp - 80 hours);
        vm.expectRevert();
        adapter.latestRate();
    }

    function testZeroMaxAgeDisablesCheck() public {
        AggregatorV3Adapter unchecked_ = new AggregatorV3Adapter(address(agg), 0);
        agg.set(SPY_8DEC, block.timestamp - 80 hours);
        assertEq(unchecked_.latestRate(), uint256(SPY_8DEC) * 1e10);
    }

    function testFutureUpdatedAtDoesNotUnderflow() public {
        agg.set(SPY_8DEC, block.timestamp + 10);
        assertEq(adapter.latestRate(), uint256(SPY_8DEC) * 1e10);
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
        emitter.registerFeed(keccak256("SPY"), address(adapter), abi.encodeCall(AggregatorV3Adapter.latestRate, ()));
    }

    function testEmitterPublishesReceiverScalableRate() public {
        OracleEmitter emitter = _emitter();
        emitter.send(keccak256("SPY"));

        (uint8 action, bytes32 assetId, uint256 rate,) = abi.decode(lastPayload, (uint8, bytes32, uint256, uint64));
        assertEq(action, 2);
        assertEq(assetId, keccak256("SPY"));
        // OracleReceiver divides by 1e10 — must land back on Chainlink's 8-dec answer.
        assertEq(rate / 1e10, uint256(SPY_8DEC));
    }

    function testEmitterSurfacesStaleRevert() public {
        OracleEmitter emitter = _emitter();
        agg.set(SPY_8DEC, block.timestamp - MAX_AGE - 1);
        vm.expectRevert();
        emitter.send(keccak256("SPY"));
    }
}
