import * as anchor from "@coral-xyz/anchor";
import type { Program } from "@coral-xyz/anchor";

import type { MessageEmitter } from "./emitter/types.js";
import log from "./logger.js";

export interface PriceFeedEntry {
  kind: "price";
  pda: anchor.web3.PublicKey;
  assetId: Uint8Array;
  priceIndex: number;
  scopePrices: anchor.web3.PublicKey;
}

export interface RateFeedEntry {
  kind: "rate";
  pda: anchor.web3.PublicKey;
  assetId: Uint8Array;
  stakePool: anchor.web3.PublicKey;
}

export type FeedEntry = PriceFeedEntry | RateFeedEntry;

export async function loadAllFeeds(program: Program<MessageEmitter>): Promise<FeedEntry[]> {
  const feeds: FeedEntry[] = [];

  const priceFeeds = await program.account.priceFeed.all();
  for (const pf of priceFeeds) {
    feeds.push({
      kind: "price",
      pda: pf.publicKey,
      assetId: new Uint8Array(pf.account.assetId),
      priceIndex: pf.account.priceIndex,
      scopePrices: pf.account.scopePrices,
    });
  }

  const poolFeeds = await program.account.stakePoolFeed.all();
  for (const sf of poolFeeds) {
    feeds.push({
      kind: "rate",
      pda: sf.publicKey,
      assetId: new Uint8Array(sf.account.assetId),
      stakePool: sf.account.stakePool,
    });
  }

  log.info(`Loaded ${priceFeeds.length} price feeds, ${poolFeeds.length} rate feeds`);
  return feeds;
}

export function assetIdStr(assetId: Uint8Array): string {
  return new anchor.web3.PublicKey(assetId).toBase58();
}
