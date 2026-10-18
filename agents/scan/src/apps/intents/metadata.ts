import { OneClickService } from "@defuse-protocol/one-click-sdk-typescript";
import { client as sdkClient } from "@galacticcouncil/sdk-next";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";

import { CHAINS } from "../../chains";
import log from "../../logger";

/** Symbol and decimals for one asset, plus the chain it lives on for destination assets. */
export interface AssetMeta {
  symbol: string;
  decimals: number;
  chain?: string;
  /** The Hydration asset whose icon it is drawn with — itself, or an aToken's underlying asset. */
  icon?: number;
}

/**
 * Memoize a loader so it runs at most once — symbols and decimals do not change at runtime.
 *
 * @param load The loader.
 */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= load());
}

/**
 * Hydration asset metadata, for formatting the asset the user sold. The only node this domain talks
 * to, and only at boot: everything else it needs is already in the database.
 */
export const hydrationAssets = once(async (): Promise<Record<number, AssetMeta>> => {
  const out: Record<number, AssetMeta> = {};
  const cfg = CHAINS["hydration"];
  if (!cfg || cfg.kind !== "substrate") return out;
  const client = createClient(getWsProvider(cfg.wssUrl));
  try {
    const assets = await new sdkClient.AssetClient(client).getSupported();
    // An aToken (aDOT, aUSDC, avDOT…) has no icon of its own; like the explorer, draw it as the
    // asset it wraps — the lowest-id plain token of that symbol, where the registry has duplicates.
    const bySymbol = new Map<string, number>();
    for (const a of [...assets].sort((x, y) => x.id - y.id)) {
      if (a.type !== "Erc20" && !bySymbol.has(a.symbol)) bySymbol.set(a.symbol, a.id);
    }
    for (const a of assets) {
      const underlying = /^a[A-Za-z]/.test(a.symbol) ? bySymbol.get(a.symbol.slice(1)) : undefined;
      out[a.id] = { symbol: a.symbol, decimals: a.decimals, icon: underlying ?? a.id };
    }
  } catch (e) {
    log.warn(`[intents] hydration assets: ${(e as Error).message}`);
  } finally {
    client.destroy();
  }
  return out;
});

/** 1Click token metadata, for formatting and labelling the destination leg. */
export const oneClickTokens = once(async (): Promise<Record<string, AssetMeta>> => {
  const out: Record<string, AssetMeta> = {};
  try {
    const tokens = await OneClickService.getTokens();
    for (const t of tokens) {
      out[t.assetId] = { symbol: t.symbol, decimals: t.decimals, chain: String(t.blockchain) };
    }
  } catch (e) {
    log.warn(`[intents] 1click tokens: ${(e as Error).message}`);
  }
  return out;
});

/** Both sides at once — what the UI needs to render an amount as anything but digits. */
export async function tokenMetadata(): Promise<{
  hydration: Record<number, AssetMeta>;
  dest: Record<string, AssetMeta>;
}> {
  const [hydration, dest] = await Promise.all([hydrationAssets(), oneClickTokens()]);
  return { hydration, dest };
}
