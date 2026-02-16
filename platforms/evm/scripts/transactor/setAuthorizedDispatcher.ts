import "dotenv/config";

import { isAddress } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "../../lib";

import xcmTransactorJson from "../../contracts/out/XcmTransactor.sol/XcmTransactor.json";

const { requiredArg, optionalArg, requiredEnv } = args;
const { getWallet } = wallet;

function getConfig() {
  const rpcUrl = requiredEnv("RECEIVER_RPC");
  const chainId = requiredEnv("RECEIVER_CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address");
  const dispatcher = requiredArg("--dispatcher");
  const enabledArg = optionalArg("--enabled");

  if (!isAddress(address)) throw new Error("Invalid transactor address.");
  if (!isAddress(dispatcher)) throw new Error("Invalid dispatcher address.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    address: address as `0x${string}`,
    privateKey: privateKey as `0x${string}`,
    dispatcher: dispatcher as `0x${string}`,
    enabled: enabledArg === "true",
  };
}

async function main(): Promise<void> {
  const { address, rpcUrl, chainId, privateKey, dispatcher, enabled } = getConfig();

  const { publicClient, walletClient } = getWallet(rpcUrl, chainId, privateKey);

  const { abi } = xcmTransactorJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: address,
    abi,
    functionName: "setAuthorized",
    args: [dispatcher, enabled],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`Dispatcher authorization ${enabled ? "granted" : "removed"}: ${dispatcher}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
