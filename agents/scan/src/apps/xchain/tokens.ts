import { createHash } from "node:crypto";

import { NTT } from "../../deployments";

export interface Token {
  symbol: string;
  decimals: number;
}

/**
 * A NEAR manager as a transfer's `source_manager` names it: its emitter, `sha256(account)`, trimmed
 * to the last 20 bytes the way every manager is.
 *
 * @param account The manager's account.
 */
const nearManager = (account: string) =>
  `0x${createHash("sha256").update(account).digest("hex").slice(24)}`;

/** Each NTT token's symbol. */
const SYMBOLS: Record<keyof typeof NTT, string> = {
  weth: "WETH",
  usdc: "USDC",
  usdt: "USDT",
  dai: "DAI",
  wbtc: "WBTC",
  susds: "sUSDS",
  eurc: "EURC",
  hdx: "HDX",
  hollar: "HOLLAR",
  spy: "SPY",
  hype: "HYPE",
  near: "NEAR",
  zec: "ZEC",
};

/**
 * Symbols by any of a token's managers, on any chain. The amount a transfer carries is already at
 * the rail's precision — its own `decimals` — so only the symbol comes from here.
 */
const BY_MANAGER = new Map(
  Object.entries(NTT).flatMap(([token, legs]) =>
    Object.values(legs as Record<string, { manager: string } | string>).map(
      (leg) =>
        [
          typeof leg === "string" ? nearManager(leg) : leg.manager.toLowerCase(),
          SYMBOLS[token as keyof typeof NTT],
        ] as const,
    ),
  ),
);

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
