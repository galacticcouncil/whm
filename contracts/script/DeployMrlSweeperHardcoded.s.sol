// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {MrlSweeperHardcoded} from "../src/MrlSweeperHardcoded.sol";

/// Deploys MrlSweeperHardcoded with the 11 MRL-asset treasury destinations baked in.
/// OWNER must be set explicitly (the EOA allowed to trigger sweeps alongside the SA).
///   OWNER=0x… forge script script/DeployMrlSweeperHardcoded.s.sol --rpc-url $MOONBEAM --broadcast
///
/// ⚠️ RECIPIENTS ARE PROVISIONAL — before any real deploy confirm:
///   - chain-2 (Ethereum) + chain-30 (Base) Safe 0xD557…81E7 is LIVE on Ethereum mainnet (currently Base-only)
///   - chain-21 (Sui) recipient is the FINAL msig (0x9fed… is interim/placeholder)
///   - chain-1 (Solana) ATAs are the per-mint associated token accounts of the Squads vault
contract DeployMrlSweeperHardcoded is Script {
    address constant DEFAULT_SA = 0x7369626cf2070000000000000000000000000000;
    address constant DEFAULT_BRIDGE = 0xB1731c586ca89a23809861c6103F0b96B3F57D92;

    function run() external returns (MrlSweeperHardcoded sweeper) {
        address sa = vm.envOr("SA", DEFAULT_SA);
        address bridge = vm.envOr("BRIDGE", DEFAULT_BRIDGE);
        address owner = vm.envAddress("OWNER"); // required — no silent default

        (address[] memory tokens, uint16[] memory chains, bytes32[] memory recipients) = dests();

        vm.startBroadcast();
        sweeper = new MrlSweeperHardcoded(sa, owner, bridge, tokens, chains, recipients);
        vm.stopBroadcast();

        console.log("MrlSweeperHardcoded:", address(sweeper));
        console.log("  SA:    ", sweeper.SA());
        console.log("  OWNER: ", sweeper.OWNER());
        console.log("  BRIDGE:", address(sweeper.BRIDGE()));
        for (uint256 i = 0; i < tokens.length; i++) {
            (uint16 c, bytes32 r, bool set) = sweeper.destOf(tokens[i]);
            require(set && c == chains[i] && r == recipients[i], "dest mismatch");
        }
        console.log("  dests set:", tokens.length);
    }

    /// 11 MRL assets → (Moonbeam ERC20, Wormhole recipient chain, bytes32 treasury recipient).
    function dests()
        internal
        pure
        returns (address[] memory tokens, uint16[] memory chains, bytes32[] memory recipients)
    {
        tokens = new address[](11);
        chains = new uint16[](11);
        recipients = new bytes32[](11);

        // ETH Safe 0xD557AeAf1e0cB3D226BfF3B7a10C2cdA9dA081E7 (Ethereum ch2 / Base ch30), left-padded to bytes32
        bytes32 ethSafe = 0x000000000000000000000000d557aeaf1e0cb3d226bff3b7a10c2cda9da081e7;

        // DAI
        tokens[0] = 0x06e605775296e851FF43b4dAa541Bb0984E9D6fD; chains[0] = 2;  recipients[0] = ethSafe;
        // WBTC
        tokens[1] = 0xE57eBd2d67B462E9926e04a8e33f01cD0D64346D; chains[1] = 2;  recipients[1] = ethSafe;
        // WETH
        tokens[2] = 0xab3f0245B83feB11d15AAffeFD7AD465a59817eD; chains[2] = 2;  recipients[2] = ethSafe;
        // USDC
        tokens[3] = 0x931715FEE2d06333043d11F658C8CE934aC61D0c; chains[3] = 2;  recipients[3] = ethSafe;
        // USDT
        tokens[4] = 0xc30E9cA94CF52f3Bf5692aaCF81353a27052c46f; chains[4] = 2;  recipients[4] = ethSafe;
        // jitoSOL (Solana ATA)
        tokens[5] = 0xE9F9a2e3dEaE4093c00FBC57b22bb51a4c05ad88; chains[5] = 1;  recipients[5] = 0x7e87fb82d2851e1630b6c0ea3fc59b02b8be023a501c017b79cc9002316cb89b;
        // PRIME (Solana ATA)
        tokens[6] = 0x52b2f622F5676E92dBeA3092004EB9fFb85A8D07; chains[6] = 1;  recipients[6] = 0xce2911d2bf99077bc8ac59dc15097bc76f25f67f8178298bf3412550064ba593;
        // EURC (Base Safe)
        tokens[7] = 0x3f9610A50630Bc7D4530736942ee2bC9e00E8De8; chains[7] = 30; recipients[7] = ethSafe;
        // sUSDS
        tokens[8] = 0xDa430218862d3dB25DE9F61458645Dde49a9e9C1; chains[8] = 2;  recipients[8] = ethSafe;
        // SOL (Solana ATA)
        tokens[9] = 0x99Fec54a5Ad36D50A4Bba3a41CAB983a5BB86A7d; chains[9] = 1;  recipients[9] = 0x4e69fc5b9315ae4d2aeeddfc7957aec78c921a5230d7e1fa75fcf24c3630ea65;
        // SUI (⚠️ provisional msig)
        tokens[10] = 0x484eCCE6775143D3335Ed2C7bCB22151C53B9F49; chains[10] = 21; recipients[10] = 0x9fed34580e448224db25a7ea654460d105d9c6f961d3f6861af1362cfe23c86b;
    }
}
