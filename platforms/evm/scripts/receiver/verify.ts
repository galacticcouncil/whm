import "dotenv/config";

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isAddress } from "viem";

import { utils } from "../../lib";

const { requiredArg, requiredEnv } = utils;

function getConfig() {
  const rpcUrl = requiredEnv("RECEIVER_RPC");
  const wormholeRelayer = requiredEnv("RECEIVER_WORMHOLE_RELAYER");
  const wormholeCore = requiredEnv("RECEIVER_WORMHOLE_CORE");
  const chainId = requiredEnv("RECEIVER_CHAIN_ID");

  if (!isAddress(wormholeRelayer)) throw new Error("Invalid wormhole relayer address.");
  if (!isAddress(wormholeCore)) throw new Error("Invalid wormhole core address.");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address");

  if (!isAddress(address)) throw new Error("Invalid receiver address.");

  return {
    rpcUrl,
    chainId,
    address: address as `0x${string}`,
    privateKey: privateKey as `0x${string}`,
    wormholeRelayer: wormholeRelayer as `0x${string}`,
    wormholeCore: wormholeCore as `0x${string}`,
  };
}

function main(): void {
  const { address, wormholeCore, wormholeRelayer, chainId } = getConfig();

  const contractsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "contracts");
  const contractSrc = "src/MessageReceiver.sol:MessageReceiver";

  const ctorArgs = execFileSync(
    "cast",
    ["abi-encode", "constructor(address,address)", wormholeRelayer, wormholeCore],
    { encoding: "utf8" },
  ).trim();

  const args = [
    "verify-contract",
    "--watch",
    "--chain",
    chainId,
    address,
    contractSrc,
    "--constructor-args",
    ctorArgs,
  ];

  // args.push("--verifier", "sourcify");

  console.log("Verifying MessageReceiver...");
  console.log("Address:", address);
  console.log("Chain:", chainId);
  console.log("Womrhole relayer:", wormholeRelayer);
  console.log("Wormhole core:", wormholeCore);
  console.log();

  execFileSync("forge", args, { cwd: contractsRoot, stdio: "inherit" });
}

main();
