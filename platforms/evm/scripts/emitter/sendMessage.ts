import "dotenv/config";

import { isAddress } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "../../lib";

import messageEmitterJson from "../../contracts/out/MessageEmitter.sol/MessageEmitter.json";

const { requiredArg, requiredEnv } = args;
const { getWallet } = wallet;

function getConfig() {
  const rpcUrl = requiredEnv("EMITTER_RPC");
  const chainId = requiredEnv("EMITTER_CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address");
  const message = requiredArg("--message");

  if (!isAddress(address)) throw new Error("Invalid emitter address.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    address: address as `0x${string}`,
    privateKey: privateKey as `0x${string}`,
    message,
  };
}

async function main(): Promise<void> {
  const { address, rpcUrl, chainId, privateKey, message } = getConfig();

  const { publicClient, walletClient } = getWallet(rpcUrl, chainId, privateKey);

  const { abi } = messageEmitterJson as ifs.ContractArtifact;

  const cost = await publicClient.readContract({
    address,
    abi,
    functionName: "quoteCrossChainCost",
  });

  const txHash = await walletClient.writeContract({
    address,
    abi,
    functionName: "sendMessage",
    args: [message],
    value: cost as bigint,
  });

  console.log("Transaction sent:", txHash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("Message sent in block:", receipt.blockNumber);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
