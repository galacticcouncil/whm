import "dotenv/config";

import { createPublicClient, createWalletClient, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { args } from "@nohaapav/whm-sdk";
import { ifs, chains } from "../../lib";

import messageReceiverJson from "../../contracts/out/MessageReceiver.sol/MessageReceiver.json";

const { requiredArg, requiredEnv } = args;
const { getChain } = chains;

function getConfig() {
  const rpcUrl = requiredEnv("RECEIVER_RPC");
  const chainId = requiredEnv("RECEIVER_CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address");
  const updater = requiredArg("--updater");
  const enabled = requiredArg("--enabled");

  if (!isAddress(address)) throw new Error("Invalid receiver address.");
  if (!isAddress(updater)) throw new Error("Invalid updater address.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    address: address as `0x${string}`,
    privateKey: privateKey as `0x${string}`,
    updater: updater as `0x${string}`,
    enabled: enabled === "true",
  };
}

async function main(): Promise<void> {
  const { address, rpcUrl, chainId, privateKey, updater, enabled } = getConfig();

  const account = privateKeyToAccount(privateKey);
  const chain = getChain(chainId);

  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({
    account: account,
    chain,
    transport,
  });

  const { abi } = messageReceiverJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: address,
    abi,
    functionName: "setRegisteredUpdater",
    args: [updater, enabled],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`Updater ${enabled ? "registered" : "unregistered"}: ${updater}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
