import "dotenv/config";

import { isAddress } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "../../lib";

import instaBridgeProxyJson from "../../contracts/out/InstaBridgeProxy.sol/InstaBridgeProxy.json";

const { requiredArg, requiredEnv } = args;
const { getWallet } = wallet;

function getConfig() {
  const rpcUrl = requiredEnv("IBRI_RPC");
  const chainId = requiredEnv("IBRI_CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address");
  const xcmTransactor = requiredArg("--xcm-transactor");

  if (!isAddress(address)) throw new Error("Invalid contract address.");
  if (!isAddress(xcmTransactor)) throw new Error("Invalid XCM transactor address.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    address: address as `0x${string}`,
    xcmTransactor: xcmTransactor as `0x${string}`,
  };
}

async function main(): Promise<void> {
  const { address, rpcUrl, chainId, privateKey, xcmTransactor } = getConfig();

  const { publicClient, walletClient } = getWallet(rpcUrl, chainId, privateKey);

  const { abi } = instaBridgeProxyJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address,
    abi,
    functionName: "setXcmTransactor",
    args: [xcmTransactor],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`XCM transactor set: ${xcmTransactor}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});