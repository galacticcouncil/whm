import "dotenv/config";

import { isAddress } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "../../lib";

import basejumpLandingJson from "../../contracts/out/BasejumpLanding.sol/BasejumpLanding.json";

const { requiredArg, requiredEnv } = args;
const { getWallet } = wallet;

function getConfig() {
  const rpcUrl = requiredEnv("RPC");
  const chainId = requiredEnv("CHAIN_ID");

  const privateKey = process.env.PK_LANDING || process.env.PK || requiredArg("--pk");
  const proxy = requiredArg("--proxy");

  if (!isAddress(proxy)) throw new Error("Invalid proxy address.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    proxy: proxy as `0x${string}`,
  };
}

async function main() {
  const config = getConfig();
  const { publicClient, walletClient } = getWallet(config.rpcUrl, config.chainId, config.privateKey);
  const { abi } = basejumpLandingJson as ifs.ContractArtifact;

  const head = await publicClient.readContract({ address: config.proxy, abi, functionName: "pendingHead" }) as bigint;
  const tail = await publicClient.readContract({ address: config.proxy, abi, functionName: "pendingTail" }) as bigint;

  console.log(`Pending: ${tail - head} (head=${head}, tail=${tail})`);

  if (head >= tail) {
    console.log("No pending transfers.");
    return;
  }

  for (let i = head; i < tail; i++) {
    const pt = await publicClient.readContract({ address: config.proxy, abi, functionName: "pendingTransfers", args: [i] }) as [string, bigint, string];
    console.log(`\n[${i}] sourceAsset=${pt[0]} amount=${pt[1]} recipient=${pt[2]}`);

    const destAsset = await publicClient.readContract({ address: config.proxy, abi, functionName: "destAssetFor", args: [pt[0]] }) as string;
    console.log(`     destAsset=${destAsset}`);

    console.log("     Fulfilling...");
    const hash = await walletClient.writeContract({
      address: config.proxy,
      abi,
      functionName: "fulfillPending",
      gas: 1_000_000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`     Tx: ${receipt.transactionHash} (status: ${receipt.status})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
