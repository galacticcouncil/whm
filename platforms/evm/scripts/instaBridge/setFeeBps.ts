import "dotenv/config";

import { isAddress } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "../../lib";

import instaBridgeJson from "../../contracts/out/InstaBridge.sol/InstaBridge.json";

const { requiredArg, requiredEnv } = args;
const { getWallet } = wallet;

function getConfig() {
  const rpcUrl = requiredEnv("IBRI_RPC");
  const chainId = requiredEnv("IBRI_CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const address = requiredArg("--address");
  const feeBps = requiredArg("--fee-bps");

  if (!isAddress(address)) throw new Error("Invalid contract address.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    address: address as `0x${string}`,
    feeBps: BigInt(feeBps),
  };
}

async function main(): Promise<void> {
  const { address, rpcUrl, chainId, privateKey, feeBps } = getConfig();

  const { publicClient, walletClient } = getWallet(rpcUrl, chainId, privateKey);

  const { abi } = instaBridgeJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address,
    abi,
    functionName: "setFeeBps",
    args: [feeBps],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`Fee BPS set: ${feeBps}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});