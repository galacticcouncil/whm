import "dotenv/config";

import { isAddress, isHex } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "../../lib";

import xcmTransactorJson from "../../contracts/out/XcmTransactor.sol/XcmTransactor.json";

const { requiredArg, requiredEnv } = args;
const { getWallet } = wallet;

function parseInput(input: string): `0x${string}` {
  if (!isHex(input)) {
    throw new Error("Invalid --input calldata. Expected a hex string (0x...).");
  }

  return input as `0x${string}`;
}

function getConfig() {
  const rpcUrl = requiredEnv("RECEIVER_RPC");
  const chainId = requiredEnv("RECEIVER_CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address");
  const target = requiredArg("--target");
  const input = requiredArg("--input");

  if (!isAddress(address)) throw new Error("Invalid transactor address.");
  if (!isAddress(target)) throw new Error("Invalid target address.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    address: address as `0x${string}`,
    privateKey: privateKey as `0x${string}`,
    target: target as `0x${string}`,
    input: parseInput(input),
  };
}

async function main(): Promise<void> {
  const { address, rpcUrl, chainId, privateKey, target, input } = getConfig();

  const { publicClient, walletClient } = getWallet(rpcUrl, chainId, privateKey);

  const { abi } = xcmTransactorJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: address,
    abi,
    functionName: "transact",
    args: [target, input],
    gas: 2_000_000n,
  });

  console.log("Transaction sent:", txHash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("Transaction included in block:", receipt.blockNumber);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
