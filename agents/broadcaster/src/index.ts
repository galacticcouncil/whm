import { HumanizeDuration, HumanizeDurationLanguage } from "humanize-duration-ts";

import { hasChangedBeyondThreshold } from "./big.js";
import { createSolanaAdapter } from "./adapters/solana.js";
import { createEthereumAdapter } from "./adapters/ethereum.js";
import type { ChainAdapter, Feed } from "./adapters/types.js";
import {
  loadState,
  loadThresholds,
  saveState,
  type BroadcasterState,
  type ThresholdMap,
} from "./state.js";
import { requiredEnv } from "./utils.js";

import log from "./logger.js";

const langService = new HumanizeDurationLanguage();
const humanizer = new HumanizeDuration(langService);

const config = {
  checkIntervalMs: 60 * 1_000,
  changeThreshold: (Number(process.env.CHANGE_THRESHOLD) || 0.1) / 100,
  fullRefreshMs: (Number(process.env.REFRESH_INTERVAL) || 24) * 60 * 60 * 1_000,
  stateFile: ".db/state.json",
  thresholdsFile: "thresholds.json",
};

interface FeedRef {
  adapter: ChainAdapter;
  feed: Feed;
}

function buildAdapters(): ChainAdapter[] {
  const adapters: ChainAdapter[] = [];

  // Each chain is opt-in via its env: Solana on RPC_URL, Ethereum on ETH_EMITTER.
  if (process.env.RPC_URL) {
    adapters.push(
      createSolanaAdapter({
        rpcUrl: requiredEnv("RPC_URL"),
        privateKey: requiredEnv("PRIVATE_KEY"),
      }),
    );
  }

  if (process.env.ETH_EMITTER) {
    adapters.push(
      createEthereumAdapter({
        rpcUrl: requiredEnv("ETH_RPC_URL"),
        chainId: Number(process.env.ETH_CHAIN_ID) || 1,
        privateKey: requiredEnv("ETH_PRIVATE_KEY") as `0x${string}`,
        emitter: requiredEnv("ETH_EMITTER") as `0x${string}`,
        fromBlock: BigInt(process.env.ETH_EMITTER_BLOCK || "0"),
        symbols: (process.env.ETH_SYMBOLS || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    );
  }

  if (adapters.length === 0) {
    throw new Error("No adapters configured. Set RPC_URL (Solana) and/or ETH_EMITTER (Ethereum).");
  }

  return adapters;
}

async function broadcastAll(refs: FeedRef[], state: BroadcasterState): Promise<void> {
  const now = Date.now();
  for (const { adapter, feed } of refs) {
    const key = feed.key;
    const last = state[key];
    if (last && now - last.sentAt < config.fullRefreshMs) {
      const ago = humanizer.humanize(now - last.sentAt, {
        round: true,
        largest: 1,
      });
      log.info(`[full-refresh] Skipping ${adapter.name}:${feed.label} (synced ${ago} ago)`);
      continue;
    }
    log.info(`[full-refresh] Broadcasting ${adapter.name}:${feed.label}`);
    try {
      const value = await adapter.read(feed);
      await adapter.send(feed);
      state[key] = { value: value.toString(), sentAt: now };
      saveState(config.stateFile, state);
    } catch (err) {
      log.error(`[full-refresh] Failed for ${adapter.name}:${feed.label}:`, err);
    }
  }
}

async function checkAndBroadcast(
  refs: FeedRef[],
  state: BroadcasterState,
  thresholds: ThresholdMap,
): Promise<void> {
  for (const { adapter, feed } of refs) {
    const key = feed.key;
    const threshold = thresholds[key] ?? config.changeThreshold;
    try {
      const current = await adapter.read(feed);
      const last = BigInt(state[key]?.value ?? "0");

      if (!hasChangedBeyondThreshold(current, last, threshold)) {
        continue;
      }

      log.info(`[check] ${adapter.name}:${feed.label} changed: ${last} -> ${current}`);
      await adapter.send(feed);
      state[key] = { value: current.toString(), sentAt: Date.now() };
      saveState(config.stateFile, state);
    } catch (err) {
      log.error(`[check] Failed for ${adapter.name}:${feed.label}:`, err);
    }
  }
}

async function main(): Promise<void> {
  log.info("Broadcaster starting");
  log.info(`  Check interval: ${config.checkIntervalMs / 1_000 / 60}m`);
  log.info(`  Full refresh: ${config.fullRefreshMs / 1_000 / 60 / 60}h`);
  log.info(`  Change threshold: ${config.changeThreshold * 100}%`);
  log.info(`  State file: ${config.stateFile}`);

  const adapters = buildAdapters();

  const refs: FeedRef[] = [];
  for (const adapter of adapters) {
    // Isolate adapters: one chain's startup failure must not take down the others.
    try {
      const feeds = await adapter.loadFeeds();
      for (const feed of feeds) refs.push({ adapter, feed });
    } catch (err) {
      log.error(`[${adapter.name}] loadFeeds failed:`, err);
    }
  }

  if (refs.length === 0) {
    log.info("No feeds registered, nothing to do");
    process.exit(0);
  }

  const state = loadState(config.stateFile);
  const thresholds = loadThresholds(config.thresholdsFile);
  for (const [assetId, threshold] of Object.entries(thresholds)) {
    log.info(`  Threshold override: ${assetId} = ${threshold * 100}%`);
  }

  // Initial full refresh on startup
  await broadcastAll(refs, state);
  let lastFullRefresh = Date.now();

  // Periodic check loop
  const tick = async () => {
    const now = Date.now();

    if (now - lastFullRefresh >= config.fullRefreshMs) {
      await broadcastAll(refs, state);
      lastFullRefresh = now;
    } else {
      await checkAndBroadcast(refs, state, thresholds);
    }
  };

  setInterval(() => {
    tick().catch((err) => log.error("[tick] Unhandled error:", err));
  }, config.checkIntervalMs);

  log.info("Broadcaster agent running...");
}

main().catch((err) => {
  log.error("Fatal:", err);
  process.exit(1);
});
