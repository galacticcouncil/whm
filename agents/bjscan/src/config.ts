import { base } from "viem/chains";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}.`);
  return v;
}

export const source = {
  name: "base",
  chain: base,
  rpcUrl: required("BASE_RPC_URL"),
  contract: "0xf5b9334e44f800382cb47fc19669401d694e529b" as `0x${string}`,
  startBlock: BigInt(process.env.BASE_START_BLOCK ?? "0"),
  confirmations: BigInt(process.env.BASE_CONFIRMATIONS ?? 3),
  chunkSize: BigInt(process.env.BASE_CHUNK_SIZE ?? 9000),
  concurrency: Number(process.env.BASE_CONCURRENCY ?? 3),
};

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
export const port = Number(process.env.PORT ?? 8080);
