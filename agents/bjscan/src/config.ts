import { base, mainnet } from "viem/chains";
import type { Chain } from "viem";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}.`);
  return v;
}

function requiredWs(name: string): string {
  const v = required(name);
  if (!v.startsWith("ws")) throw new Error(`${name} must be a websocket url (ws:// or wss://).`);
  return v;
}

export interface SourceCfg {
  name: string;
  chain: Chain;
  rpcUrl: string;
  contract: `0x${string}`;
  startBlock: bigint;
  confirmations: bigint;
  chunkSize: bigint;
  concurrency: number;
}

export const sources: SourceCfg[] = [
  {
    name: "base",
    chain: base,
    rpcUrl: requiredWs("BASE_RPC_URL"),
    contract: "0xf5b9334e44f800382cb47fc19669401d694e529b" as `0x${string}`,
    startBlock: BigInt(process.env.BASE_START_BLOCK ?? "0"),
    confirmations: BigInt(process.env.BASE_CONFIRMATIONS ?? 3),
    chunkSize: BigInt(process.env.BASE_CHUNK_SIZE ?? 9000),
    concurrency: Number(process.env.BASE_CONCURRENCY ?? 3),
  },
];

if (process.env.ETHEREUM_RPC_URL) {
  sources.push({
    name: "ethereum",
    chain: mainnet,
    rpcUrl: requiredWs("ETHEREUM_RPC_URL"),
    contract: required("ETHEREUM_CONTRACT").toLowerCase() as `0x${string}`,
    startBlock: BigInt(process.env.ETHEREUM_START_BLOCK ?? "25300000"),
    confirmations: BigInt(process.env.ETHEREUM_CONFIRMATIONS ?? 3),
    chunkSize: BigInt(process.env.ETHEREUM_CHUNK_SIZE ?? 9000),
    concurrency: Number(process.env.ETHEREUM_CONCURRENCY ?? 3),
  });
} else if (process.env.ETHEREUM_CONTRACT) {
  throw new Error("Partial ethereum config: set ETHEREUM_RPC_URL or unset ETHEREUM_CONTRACT.");
}
export const destination = {
  name: "hydration",
  chainId: 222222,
  wssUrl: required("HYDRATION_WSS_URL"),
  contract: "0x70e9b12c3b19cb5f0e59984a5866278ab69df976" as `0x${string}`,
  startBlock: BigInt(process.env.HYDRATION_START_BLOCK ?? "0"),
  confirmations: BigInt(process.env.HYDRATION_CONFIRMATIONS ?? 0),
  concurrency: Number(process.env.HYDRATION_CONCURRENCY ?? 100),
  checkpointEvery: Number(process.env.HYDRATION_CHECKPOINT_EVERY ?? 500),
};

export const databaseUrl = required("DATABASE_URL");
export const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 5_000);
export const liveIntervalMs = Number(process.env.LIVE_POLL_INTERVAL_MS ?? 12_000);
export const port = Number(process.env.PORT ?? 8080);
