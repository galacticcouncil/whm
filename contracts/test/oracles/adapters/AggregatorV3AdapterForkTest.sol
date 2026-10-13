// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {AggregatorV3Adapter} from "../../../src/oracles/adapters/AggregatorV3Adapter.sol";
import {IAggregatorV3} from "../../../src/oracles/interfaces/IAggregatorV3.sol";

/// @dev Robinhood Chain fork test. Verifies the live SPY/USD Chainlink proxy reads through the
///      adapter as an 18-dec rate that OracleReceiver's ÷1e10 maps back to the feed's 8-dec answer.
///
///      Run with: forge test --match-contract AggregatorV3AdapterForkTest
///      Requires the `robinhood` rpc endpoint in foundry.toml.
contract AggregatorV3AdapterForkTest is Test {
    address constant SPY_USD_FEED = 0x319724394D3A0e3669269846abE664Cd621f9f6A;

    AggregatorV3Adapter public adapter;

    function setUp() public {
        vm.createSelectFork("robinhood");
        adapter = new AggregatorV3Adapter(SPY_USD_FEED, 0);
    }

    function testFeedIsSpyUsd8Dec() public view {
        assertEq(IAggregatorV3(SPY_USD_FEED).decimals(), 8);
    }

    function testLiveRateRoundTrips() public view {
        (, int256 answer,,,) = IAggregatorV3(SPY_USD_FEED).latestRoundData();
        uint256 rate = adapter.latestRate();

        assertEq(rate, uint256(answer) * 1e10);
        assertEq(rate / 1e10, uint256(answer));
        // Sanity band: SPY between $100 and $10,000.
        assertGt(rate, 100e18);
        assertLt(rate, 10_000e18);
    }
}
