import "dotenv/config";

import { decodeEventLog, isAddress, keccak256, toBytes } from "viem";

import { args } from "@whm/common";
import { ifs, wallet } from "../../lib";

import oracleEmitterJson from "../../contracts/out/OracleEmitter.sol/OracleEmitter.json";

const { requiredArg, requiredEnv } = args;
const { getWallet } = wallet;

function getConfig() {
  const rpcUrl = requiredEnv("RPC");
  const chainId = requiredEnv("CHAIN_ID");

  const privateKey = requiredArg("--pk");
  const proxy = requiredArg("--proxy");
  const symbol = requiredArg("--symbol");

  if (!isAddress(proxy)) throw new Error("Invalid proxy address.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    privateKey: privateKey as `0x${string}`,
    proxy: proxy as `0x${string}`,
    symbol,
  };
}

async function main(): Promise<void> {
  const { rpcUrl, chainId, privateKey, proxy, symbol } = getConfig();

  const { publicClient, walletClient } = getWallet(rpcUrl, chainId, privateKey);

  const { abi } = oracleEmitterJson as ifs.ContractArtifact;

  const assetId = keccak256(toBytes(symbol));

  const cost = (await publicClient.readContract({
    address: proxy,
    abi,
    functionName: "quoteCrossChainCost",
  })) as bigint;

  console.log(`symbol  = ${symbol}`);
  console.log(`assetId = ${assetId}`);
  console.log(`fee     = ${cost}`);

  const txHash = await walletClient.writeContract({
    address: proxy,
    abi,
    functionName: "send",
    args: [assetId],
    value: cost,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== proxy.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (decoded.eventName === "RatePublished") {
        const { rate, sequence } = decoded.args as unknown as {
          rate: bigint;
          sequence: bigint;
        };
        console.log(`rate     = ${rate}`);
        console.log(`sequence = ${sequence}`);
        break;
      }
    } catch {
      // not a matching event
    }
  }

  console.log(`Sent. Tx: ${receipt.transactionHash}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
