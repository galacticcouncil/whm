import "dotenv/config";

import { isAddress } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "../../lib";

import messageDispatcherJson from "../../contracts/out/MessageDispatcher.sol/MessageDispatcher.json";

const { requiredArg, requiredEnv } = args;
const { getWallet } = wallet;

function getConfig() {
  const rpcUrl = requiredEnv("RECEIVER_RPC");
  const chainId = requiredEnv("RECEIVER_CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address");
  const handler = requiredArg("--handler");
  const action = Number(requiredArg("--action-id"));

  if (!isAddress(address)) throw new Error("Invalid dispatcher address.");
  if (!isAddress(handler)) throw new Error("Invalid handler address.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    address: address as `0x${string}`,
    privateKey: privateKey as `0x${string}`,
    handler: handler as `0x${string}`,
    action,
  };
}

async function main(): Promise<void> {
  const { address, rpcUrl, chainId, privateKey, handler, action } = getConfig();

  const { publicClient, walletClient } = getWallet(rpcUrl, chainId, privateKey);

  const { abi } = messageDispatcherJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: address,
    abi,
    functionName: "setHandler",
    args: [action, handler],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`Dispatcher handler set: action=${action}, handler=${handler}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
