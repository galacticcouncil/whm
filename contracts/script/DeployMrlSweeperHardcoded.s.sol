// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {MrlSweeperHardcoded} from "../src/MrlSweeperHardcoded.sol";

/// Deploys MrlSweeperHardcoded via CREATE2 (deterministic address, independent of deployer nonce) so
/// the approve proposal can target the exact address BEFORE the deploy tx lands. Destinations are
/// hardcoded in the contract bytecode (see MrlSweeperHardcoded._destFor) — no constructor dest args.
///
///   # 1. precompute the address (no broadcast — prints the CREATE2 address):
///   OWNER=0x… forge script script/DeployMrlSweeperHardcoded.s.sol
///   # 2. build the approve proposal against it:  SWEEPER=<addr> pnpm tsx probes/_buildApproveProposal.ts
///   # 3. deploy:
///   OWNER=0x… RECIPIENTS_FINAL=1 forge script script/DeployMrlSweeperHardcoded.s.sol --rpc-url $MOONBEAM --broadcast
///
/// ⚠️ The recipients hardcoded in the contract are PROVISIONAL + IMMUTABLE once deployed. Deploy is GATED
/// on RECIPIENTS_FINAL=1, set only after confirming the source constants:
///   - chain-2 (Ethereum) + chain-30 (Base) Safe 0xD557…81E7 is LIVE + controlled on Ethereum mainnet
///   - chain-21 (Sui) recipient is the FINAL msig (0x9fed… is interim/placeholder)
///   - chain-1 (Solana) ATAs are the per-mint associated token accounts of the Squads vault
contract DeployMrlSweeperHardcoded is Script {
    address constant DEFAULT_SA = 0x7369626cf2070000000000000000000000000000;
    address constant DEFAULT_BRIDGE = 0xB1731c586ca89a23809861c6103F0b96B3F57D92;
    bytes32 constant DEFAULT_SALT = keccak256("hydration.mrl.sweeper.v1");

    function run() external returns (MrlSweeperHardcoded sweeper) {
        address sa = vm.envOr("SA", DEFAULT_SA);
        address bridge = vm.envOr("BRIDGE", DEFAULT_BRIDGE);
        address owner = vm.envAddress("OWNER"); // required — no silent default
        bytes32 salt = vm.envOr("SALT", DEFAULT_SALT);

        bytes memory initCode = abi.encodePacked(
            type(MrlSweeperHardcoded).creationCode,
            abi.encode(sa, owner, bridge)
        );
        address predicted = vm.computeCreate2Address(salt, keccak256(initCode));
        console.log("predicted (CREATE2):", predicted);
        console.log("  owner:", owner);
        console.log("  salt :", vm.toString(salt));

        if (!vm.envOr("RECIPIENTS_FINAL", false)) {
            console.log("RECIPIENTS_FINAL not set -> address-only (no deploy). Verify hardcoded recipients, then set RECIPIENTS_FINAL=1.");
            return MrlSweeperHardcoded(predicted);
        }

        vm.startBroadcast();
        sweeper = new MrlSweeperHardcoded{salt: salt}(sa, owner, bridge);
        vm.stopBroadcast();
        require(address(sweeper) == predicted, "create2 address drift");

        console.log("MrlSweeperHardcoded:", address(sweeper));
        console.log("  SA:    ", sweeper.SA());
        console.log("  OWNER: ", sweeper.OWNER());
        console.log("  BRIDGE:", address(sweeper.BRIDGE()));
    }
}
