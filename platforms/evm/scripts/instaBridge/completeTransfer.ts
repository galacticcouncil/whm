import "dotenv/config";

import { isAddress, isHex } from "viem";

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
  const vaa = requiredArg("--vaa");

  if (!isAddress(address)) throw new Error("Invalid contract address.");
  if (!isHex(vaa)) throw new Error("Invalid VAA (expected hex).");

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    address: address as `0x${string}`,
    vaa: vaa as `0x${string}`,
  };
}

async function main(): Promise<void> {
  const { address, rpcUrl, chainId, privateKey, vaa } = getConfig();

  const { publicClient, walletClient } = getWallet(rpcUrl, chainId, privateKey);

  const { abi } = instaBridgeJson as ifs.ContractArtifact;

  const txHash = await walletClient.writeContract({
    address,
    abi,
    functionName: "completeTransfer",
    args: [vaa],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`Transfer completed: tx=${receipt.transactionHash}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
