import { defineChain, type Chain } from "viem";
import { base, hyperEvm, mainnet } from "viem/chains";

export interface EvmChainDef {
  /** The key everything else addresses the chain by. */
  name: string;
  chain: Chain;
  wormholeId: number;
  /** Env prefix, e.g. `ETHEREUM` for `RPC_ETHEREUM_WSS`. */
  prefix: string;
  /** Blocks per getLogs, where the chain's RPCs cap the range below the default. */
  chunkSize?: bigint;
  /** getLogs in flight, where the chain's RPCs rate-limit below the default. */
  concurrency?: number;
}

/** Robinhood Chain — an Arbitrum Orbit chain viem does not know yet. */
const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
});

export const ETHEREUM: EvmChainDef = {
  name: "ethereum",
  chain: mainnet,
  wormholeId: 2,
  prefix: "ETHEREUM",
};
export const BASE: EvmChainDef = { name: "base", chain: base, wormholeId: 30, prefix: "BASE" };
/** Its public RPC caps getLogs at 1,000 blocks and rate-limits hard. */
export const HYPEREVM: EvmChainDef = {
  name: "hyperevm",
  chain: hyperEvm,
  wormholeId: 47,
  prefix: "HYPEREVM",
  chunkSize: 1_000n,
  concurrency: 1,
};
/**
 * 100ms blocks — 864k a day — so the default range would take thousands of calls; its public RPC
 * answers a filtered getLogs over 5M blocks.
 */
export const ROBINHOOD: EvmChainDef = {
  name: "robinhood",
  chain: robinhood,
  wormholeId: 72,
  prefix: "ROBINHOOD",
  chunkSize: 1_000_000n,
};

export const EVM_CHAINS: EvmChainDef[] = [ETHEREUM, BASE, HYPEREVM, ROBINHOOD];
