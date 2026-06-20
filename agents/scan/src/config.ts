import { base, mainnet, moonbeam } from "viem/chains";
import type { Chain } from "viem";

import type { ChainCfg, EvmChain, SubstrateChain } from "./types";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}.`);
  return v;
}

/** Build an EVM chain config when its RPC env is present, else null (chain disabled). */
function evmChain(name: string, chain: Chain, prefix: string, confirmations: string): EvmChain | null {
  const rpcUrl = process.env[`${prefix}_RPC_URL`];
  if (!rpcUrl) return null;
  if (!rpcUrl.startsWith("ws")) {
    throw new Error(`${prefix}_RPC_URL must be a websocket url (ws:// or wss://).`);
  }
  return {
    name,
    kind: "evm",
    chain,
    rpcUrl,
    startBlock: BigInt(required(`${prefix}_START_BLOCK`)),
    confirmations: BigInt(process.env[`${prefix}_CONFIRMATIONS`] ?? confirmations),
    chunkSize: BigInt(process.env[`${prefix}_CHUNK_SIZE`] ?? 9000),
    concurrency: Number(process.env[`${prefix}_CONCURRENCY`] ?? 3),
  };
}

function hydrationChain(): SubstrateChain | null {
  const wssUrl = process.env.HYDRATION_WSS_URL;
  if (!wssUrl) return null;
  return {
    name: "hydration",
    kind: "substrate",
    chainId: Number(process.env.HYDRATION_CHAIN_ID ?? 222222),
    wssUrl,
    startBlock: BigInt(required("HYDRATION_START_BLOCK")),
    confirmations: BigInt(process.env.HYDRATION_CONFIRMATIONS ?? 0),
    concurrency: Number(process.env.HYDRATION_CONCURRENCY ?? 100),
    checkpointEvery: Number(process.env.HYDRATION_CHECKPOINT_EVERY ?? 500),
  };
}

/**
 * Enabled chains, keyed by name. A chain is enabled iff its RPC env var is set, so an
 * operator turns chains on/off purely through env. Add an L2 by adding one `evmChain(...)`
 * line and the matching `<PREFIX>_RPC_URL` / `<PREFIX>_START_BLOCK`.
 */
export const chains: Record<string, ChainCfg> = {};
for (const c of [
  evmChain("base", base, "BASE", "3"),
  evmChain("ethereum", mainnet, "ETHEREUM", "3"),
  evmChain("moonbeam", moonbeam, "MOONBEAM", "3"),
  hydrationChain(),
]) {
  if (c) chains[c.name] = c;
}

export const databaseUrl = required("DATABASE_URL");
export const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 5_000);
export const liveIntervalMs = Number(process.env.LIVE_POLL_INTERVAL_MS ?? 12_000);
export const port = Number(process.env.PORT ?? 8080);

/** Lowercased address from env (with optional prod default), or undefined if unset. */
function addr(name: string, def?: string): `0x${string}` | undefined {
  const v = process.env[name] ?? def;
  return v ? (v.toLowerCase() as `0x${string}`) : undefined;
}

/** Basejump watched contracts (per chain). */
export const basejumpConfig = {
  base: addr("BASEJUMP_BASE", "0xf5b9334e44f800382cb47fc19669401d694e529b"),
  ethereum: addr("BASEJUMP_ETHEREUM"),
  hydrationLanding: addr("BASEJUMP_LANDING_HYDRATION", "0x70e9b12c3b19cb5f0e59984a5866278ab69df976"),
};

/** Intents (WTT) watched contracts. Defaults are the prod `nintent-ethereum` deployment. */
export const intentsConfig = {
  emitterHydration: addr("INTENT_EMITTER_HYDRATION", "0x059ed5658c988976e73adb6597418970414f3dd0"),
  receiverEthereum: addr("INTENT_RECEIVER_ETHEREUM", "0xf1a5fe4252d9a1c39b0fb9de1f19049ee57ed188"),
  wormholeCoreMoonbeam: addr("WORMHOLE_CORE_MOONBEAM", "0xc8e2b0cd52cf01b0ce87d389daa3d414d4ce29f3"),
  // sender filter for Moonbeam LogMessagePublished — only the TokenBridge's publishes are intent-relevant
  tokenBridgeMoonbeam: addr("TOKEN_BRIDGE_MOONBEAM", "0xb1731c586ca89a23809861c6103f0b96b3f57d92"),
};
