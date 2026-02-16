import "dotenv/config";

import { isAddress } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "../../lib";

import xcmTransactorJson from "../../contracts/out/XcmTransactor.sol/XcmTransactor.json";

const { requiredArg, requiredEnv } = args;
const { getWallet } = wallet;

function getConfig() {
  const rpcUrl = requiredEnv("RECEIVER_RPC");
  const chainId = requiredEnv("RECEIVER_CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address");
  const operator = requiredArg("--operator");
  const enabled = requiredArg("--enabled");

  if (!isAddress(address)) throw new Error("Invalid transactor address.");
  if (!isAddress(operator)) throw new Error("Invalid operator address.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    address: address as `0x${string}`,
    privateKey: privateKey as `0x${string}`,
    operator: operator as `0x${string}`,
    enabled: enabled === "true",
  };
}

async function main(): Promise<void> {
  const { address, rpcUrl, chainId, privateKey, operator, enabled } = getConfig();

  const { publicClient, walletClient } = getWallet(rpcUrl, chainId, privateKey);

  const { abi } = xcmTransactorJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address: address,
    abi,
    functionName: "setAuthorized",
    args: [operator, enabled],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`Authorization ${enabled ? "granted" : "removed"}: ${operator}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
