// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {MrlSweeper} from "../src/MrlSweeper.sol";

/// deploys MrlSweeper(SA, bridge). SA = Hydration Moonbeam sovereign acct,
/// bridge = Wormhole token bridge on Moonbeam. override via env SA / BRIDGE.
contract DeployMrlSweeper is Script {
    // Moonbeam mainnet defaults
    address constant DEFAULT_SA = 0x7369626cf2070000000000000000000000000000;
    address constant DEFAULT_BRIDGE = 0xB1731c586ca89a23809861c6103F0b96B3F57D92;

    function run() external returns (MrlSweeper sweeper) {
        address sa = vm.envOr("SA", DEFAULT_SA);
        address bridge = vm.envOr("BRIDGE", DEFAULT_BRIDGE);

        vm.startBroadcast();
        sweeper = new MrlSweeper(sa, bridge);
        vm.stopBroadcast();

        console.log("MrlSweeper:", address(sweeper));
        console.log("  SA:      ", sweeper.SA());
        console.log("  BRIDGE:  ", address(sweeper.BRIDGE()));
    }
}
