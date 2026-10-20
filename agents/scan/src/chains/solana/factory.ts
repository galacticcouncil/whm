import { SOLANA, SOLANA_RPC } from "./consts";
import type { SolanaChain } from "./types";

/**
 * Solana's config. Always on: its public RPC is enough for what NTT puts through it, so
 * `RPC_SOLANA_HTTP` only overrides it. `RPC_SOLANA_WSS`, where set, wakes the watcher on new logs
 * rather than waiting out the poll.
 */
export function solana(): SolanaChain {
  const wss = process.env.RPC_SOLANA_WSS;
  if (wss && !wss.startsWith("ws")) {
    throw new Error("RPC_SOLANA_WSS must be a websocket url (ws:// or wss://).");
  }
  return {
    ...SOLANA,
    kind: "solana",
    rpcUrl: process.env.RPC_SOLANA_HTTP || SOLANA_RPC,
    wssUrl: wss || undefined,
    confirmations: 0n,
    concurrency: Number(process.env.CONCURRENCY_SOLANA ?? 2),
    pollMs: Number(process.env.POLL_MS_SOLANA ?? 10_000),
  };
}
