import "dotenv/config";

import { createPublicClient, createWalletClient, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { args } from "@nohaapav/whm-sdk";
import { ifs, chains } from "../../lib";

import messageDispatcherJson from "../../contracts/out/MessageDispatcher.sol/MessageDispatcher.json";

const { requiredArg, requiredEnv } = args;
const { getChain } = chains;

function getConfig() {
  const rpcUrl = requiredEnv("RECEIVER_RPC");
  const chainId = requiredEnv("RECEIVER_CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address");
  const handler = requiredArg("--handler");
  const action = Number(requiredArg("--action"));

  if (!isAddress(address)) throw new Error("Invalid dispatcher address.");
  if (!isAddress(handler)) throw new Error("Invalid handler address.");
  if (!Number.isInteger(action) || action < 0 || action > 255) {
    throw new Error("Invalid action (expected uint8 value: 0-255).");
  }

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

  const account = privateKeyToAccount(privateKey);
  const chain = getChain(chainId);

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({
    account: account,
    chain,
    transport,
  });

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
