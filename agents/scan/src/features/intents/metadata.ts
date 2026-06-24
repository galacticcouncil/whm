import { client as sdkClient } from "@galacticcouncil/sdk-next";
import { OneClickService } from "@defuse-protocol/one-click-sdk-typescript";

import log from "../../logger";
import { clients } from "../../clients";

/** Symbol + decimals for one asset, plus the chain it lives on (destination assets only). */
export interface AssetMeta {
  symbol: string;
  decimals: number;
  chain?: string;
}

/** Memoize a loader so it runs at most once (asset symbol/decimals don't change at runtime). */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= load());
}

/**
 * Hydration asset metadata (asset id → symbol/decimals) via sdk-next `AssetClient.getSupported()`
 * over the existing Hydration papi client — used to format the `asset_in` leg. `{}` if Hydration
 * isn't enabled or the query fails (the UI falls back to the raw id/amount).
 */
export const hydrationAssets = once(async (): Promise<Record<number, AssetMeta>> => {
  const out: Record<number, AssetMeta> = {};
  const c = clients["hydration"]?.substrate;
  if (!c) return out;
  try {
    const assets = await new sdkClient.AssetClient(c).getSupported();
    for (const a of assets) out[a.id] = { symbol: a.symbol, decimals: a.decimals };
  } catch (e) {
    log.warn(`[intents] hydration assets: ${(e as Error).message}`);
  }
  return out;
});

/**
 * 1Click token metadata (asset id → symbol/decimals/chain) via `getTokens()` — used to format the
 * destination (`Out`) leg and label the destination chain. `{}` on a transient error.
 */
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

/** Combined metadata for the UI: Hydration source assets + 1Click destination assets. */
export async function tokenMetadata(): Promise<{
  hydration: Record<number, AssetMeta>;
  dest: Record<string, AssetMeta>;
}> {
  const [hydration, dest] = await Promise.all([hydrationAssets(), oneClickTokens()]);
  return { hydration, dest };
}
