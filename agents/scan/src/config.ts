import { base, mainnet, moonbeam } from "viem/chains";
import type { Chain } from "viem";

import type { ChainCfg, EvmChain, SubstrateChain } from "./types";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}.`);
  return v;
}

/** Build an EVM chain config when its RPC env is present, else null (chain disabled). */
function evmChain(
  name: string,
  chain: Chain,
  prefix: string,
  confirmations: string,
): EvmChain | null {
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
export const intentsSettlementPollMs = Number(process.env.INTENTS_SETTLEMENT_POLL_MS ?? 15_000);
// 1Click API JWT for the intents settlement poller (getExecutionStatus); required when intents is enabled.
export const oneClickJwt = process.env.ONECLICK_JWT;
export const port = Number(process.env.PORT ?? 8080);

/**
 * Lowercased address list from a comma-separated env var; `[]` if unset. No code fallbacks — every
 * contract address is configured via env, so nothing is baked into the build.
 */
function addrs(name: string): `0x${string}`[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean) as `0x${string}`[];
}

/** A Basejump landing deployment — one row per watched landing contract. */
export interface BasejumpLanding {
  chain: string;
  address: `0x${string}`;
}

function basejumpLandings(): BasejumpLanding[] {
  // Comma-separated list, one entry per landing contract on Hydration. Multiple landings (independent
  // Basejump deployments) merge into one unified transfers view.
  return addrs("BASEJUMP_LANDING_HYDRATION").map((address) => ({ chain: "hydration", address }));
}

// Canonical Wormhole deployments on Moonbeam — fixed infra (never change), so hardcoded, not env-driven.
const MOONBEAM_WORMHOLE_CORE = "0xc8e2b0cd52cf01b0ce87d389daa3d414d4ce29f3" as `0x${string}`;
const MOONBEAM_WORMHOLE_TOKEN_BRIDGE =
  "0xb1731c586ca89a23809861c6103f0b96b3f57d92" as `0x${string}`;

/**
 * Watched contracts. Each project-contract role is a COMMA-SEPARATED ADDRESS LIST configured purely
 * via env (no code fallbacks) — multiple deployments of a role merge into one unified view
 * (e.g. BASEJUMP_LANDING_HYDRATION=0xA,0xB). The Moonbeam Wormhole core / token bridge are the only
 * hardcoded addresses (fixed infra, above).
 */
export const basejumpConfig = {
  sources: {
    base: addrs("BASEJUMP_BASE"),
    ethereum: addrs("BASEJUMP_ETHEREUM"),
  } as Record<string, `0x${string}`[]>,
  landings: basejumpLandings(),
};

export const intentsConfig = {
  emitterHydration: addrs("INTENT_EMITTER_HYDRATION"),
  receiverEthereum: addrs("INTENT_RECEIVER_ETHEREUM"),
  // sender filter narrows the Moonbeam Wormhole-core firehose to the TokenBridge's publishes
  wormholeCoreMoonbeam: MOONBEAM_WORMHOLE_CORE,
  tokenBridgeMoonbeam: MOONBEAM_WORMHOLE_TOKEN_BRIDGE,
};
