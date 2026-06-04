import "dotenv/config";

import { createPublicClient, http, isAddress, keccak256, toBytes } from "viem";

import { args } from "@whm/common";
import { chains, ifs } from "@whm/common/evm";

import oracleEmitterJson from "../../out/OracleEmitter.sol/OracleEmitter.json";

const { requiredArg, requiredEnv } = args;

function getConfig() {
  const rpcUrl = requiredEnv("RPC");
  const chainId = requiredEnv("CHAIN_ID");

  const proxy = requiredArg("--proxy");
  const symbol = requiredArg("--symbol");

  if (!isAddress(proxy)) throw new Error("Invalid proxy address.");

  return {
    rpcUrl,
    chainId: Number(chainId),
    proxy: proxy as `0x${string}`,
    symbol,
  };
}

async function main(): Promise<void> {
  const { rpcUrl, chainId, proxy, symbol } = getConfig();

  const publicClient = createPublicClient({
    chain: chains.getChain(chainId),
    transport: http(rpcUrl),
  });

  const { abi } = oracleEmitterJson as ifs.ContractArtifact;

  const assetId = keccak256(toBytes(symbol));

  const feed = (await publicClient.readContract({
    address: proxy,
    abi,
    functionName: "feeds",
    args: [assetId],
  })) as readonly [`0x${string}`, `0x${string}`];

  const [source, call] = feed;

  console.log(`symbol  = ${symbol}`);
  console.log(`assetId = ${assetId}`);
  console.log(`source  = ${source}`);
  console.log(`call    = ${call}`);

  if (source === "0x0000000000000000000000000000000000000000") {
    console.log("(feed is not registered)");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
