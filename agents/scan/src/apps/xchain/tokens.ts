import { createHash } from "node:crypto";

import { base58 } from "@scure/base";

import { NTT, type NttLeg } from "../../deployments";

import { ROUTES } from "./utxo/routes";

export interface Token {
  symbol: string;
  decimals: number;
}

/** What the pages need to draw a token: its symbol, its Hydration asset (the icon), its home chain. */
export interface TokenMeta {
  symbol: string;
  /** Hydration asset id — the registry keys icons by it. */
  assetId: number;
  /** Where it is native: the corner of its icon. */
  home: string;
}

/**
 * A manager as a transfer's `source_manager` names it: its 32 bytes trimmed to the last 20, the way
 * every manager is. NEAR's 32 bytes are `sha256(account)`; Solana's, the program's key; Sui's, the
 * state object's id.
 *
 * @param leg The token's leg on one chain.
 */
function managerKey(leg: NttLeg): string {
  if (typeof leg === "string")
    return `0x${createHash("sha256").update(leg).digest("hex").slice(24)}`;
  if ("program" in leg)
    return `0x${Buffer.from(base58.decode(leg.program)).toString("hex").slice(24)}`;
  if ("state" in leg) return `0x${leg.state.slice(-40)}`;
  return leg.manager.toLowerCase();
}

/**
 * Each NTT token: symbol, Hydration asset id and home chain. The asset id is the last four bytes of
 * the token's Hydration precompile address in hydration-ntt's deployment.json; HOLLAR is an ERC20
 * there, asset 222.
 */
export const NTT_TOKENS: Record<keyof typeof NTT, TokenMeta> = {
  weth: { symbol: "WETH", assetId: 20, home: "ethereum" },
  usdc: { symbol: "USDC", assetId: 21, home: "ethereum" },
  usdt: { symbol: "USDT", assetId: 23, home: "ethereum" },
  dai: { symbol: "DAI", assetId: 18, home: "ethereum" },
  wbtc: { symbol: "WBTC", assetId: 19, home: "ethereum" },
  susds: { symbol: "sUSDS", assetId: 1_000_745, home: "ethereum" },
  eurc: { symbol: "EURC", assetId: 44, home: "base" },
  hdx: { symbol: "HDX", assetId: 0, home: "hydration" },
  hollar: { symbol: "HOLLAR", assetId: 222, home: "hydration" },
  spy: { symbol: "SPY", assetId: 1_001_356, home: "robinhood" },
  hype: { symbol: "HYPE", assetId: 1_001_355, home: "hyperevm" },
  near: { symbol: "NEAR", assetId: 1_001_358, home: "near" },
  zec: { symbol: "ZEC", assetId: 1_001_357, home: "zcash" },
  sol: { symbol: "SOL", assetId: 1_000_752, home: "solana" },
  jitosol: { symbol: "JitoSOL", assetId: 40, home: "solana" },
  prime: { symbol: "PRIME", assetId: 43, home: "solana" },
  sui: { symbol: "SUI", assetId: 1_000_753, home: "sui" },
};

/** Every token by symbol — what a page draws a row's amount with. */
export const TOKENS: TokenMeta[] = Object.values(NTT_TOKENS);

/** The keys a token appears under in the transfers union's `token` column, by symbol. */
const KEYS = new Map<string, string[]>();
const addKey = (symbol: string, key: string) =>
  KEYS.set(symbol, [...(KEYS.get(symbol) ?? []), key.toLowerCase()]);

/**
 * Symbols by any of a token's managers, on any chain. The amount a transfer carries is already at
 * the rail's precision — its own `decimals` — so only the symbol comes from here.
 */
const BY_MANAGER = new Map<string, string>();
for (const [token, legs] of Object.entries(NTT)) {
  const symbol = NTT_TOKENS[token as keyof typeof NTT].symbol;
  for (const leg of Object.values(legs as Record<string, NttLeg>)) {
    const manager = managerKey(leg);
    BY_MANAGER.set(manager, symbol);
    addKey(symbol, manager);
  }
}

/**
 * An NTT transfer's symbol, by its source manager.
 *
 * @param manager `source_manager`.
 */
export const nttSymbol = (manager: string | null) =>
  (manager && BY_MANAGER.get(manager.toLowerCase())) ?? null;

/** Basejump's source assets on Ethereum. */
export const BASEJUMP_ASSETS: Record<string, Token> = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
};

for (const [asset, t] of Object.entries(BASEJUMP_ASSETS)) addKey(t.symbol, asset);
for (const r of ROUTES) addKey(r.symbol, r.chain);

/**
 * The `token` keys that mean any of these symbols — an NTT manager, a Basejump asset, a UTXO coin's
 * chain — for an asset filter.
 *
 * @param symbols Symbols, as the pages show them.
 */
export const tokenKeys = (symbols: string[]) => symbols.flatMap((s) => KEYS.get(s) ?? []);
