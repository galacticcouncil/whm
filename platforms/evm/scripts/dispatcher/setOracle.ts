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
  const oracle = requiredArg("--oracle");
  const assetId = requiredArg("--asset-id");

  if (!isAddress(address)) throw new Error("Invalid dispatcher address.");
  if (!isAddress(oracle)) throw new Error("Invalid oracle address.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    address: address as `0x${string}`,
    privateKey: privateKey as `0x${string}`,
    oracle: oracle as `0x${string}`,
    assetId,
  };
}

async function main(): Promise<void> {
  const { address, rpcUrl, chainId, privateKey, oracle, assetId } = getConfig();

  const { publicClient, walletClient } = getWallet(rpcUrl, chainId, privateKey);

  const { abi } = messageDispatcherJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: address,
    abi,
    functionName: "setOracle",
    args: [assetId, oracle],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`Dispatcher oracle set: assetId=${assetId}, oracle=${oracle}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
