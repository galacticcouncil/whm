import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";

import { HumanizeDuration, HumanizeDurationLanguage } from "humanize-duration-ts";

import idl from "./emitter/idl.json";
import type { MessageEmitter } from "./emitter/types.js";

import { hasChangedBeyondThreshold } from "./big.js";
import { loadAllFeeds, assetIdStr, type FeedEntry } from "./feeds.js";
import { readCurrentValue } from "./reader.js";
import { sendUpdate } from "./sender.js";
import { loadState, saveState, type BroadcasterState } from "./state.js";
import { loadKeypair, requiredEnv } from "./utils";

import log from "./logger.js";

const langService = new HumanizeDurationLanguage();
const humanizer = new HumanizeDuration(langService);

const config = {
  rpcUrl: requiredEnv("RPC_URL"),
  privateKey: requiredEnv("PRIVATE_KEY"),
  changeThreshold: 0.05,
  checkIntervalMs: 60 * 1_000,
  fullRefreshMs: (Number(process.env.REFRESH_INTERVAL) || 24) * 60 * 60 * 1_000,
  stateFile: ".db/state.json",
};

function buildProgram(): Program<MessageEmitter> {
  const keypair = loadKeypair(config.privateKey);
  const connection = new anchor.web3.Connection(config.rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return new Program<MessageEmitter>(idl as MessageEmitter, provider);
}

async function broadcastAll(
  program: Program<MessageEmitter>,
  feeds: FeedEntry[],
  state: BroadcasterState,
): Promise<void> {
  const now = Date.now();
  for (const feed of feeds) {
    const key = assetIdStr(feed.assetId);
    const last = state[key];
    if (last && now - last.sentAt < config.fullRefreshMs) {
      const ago = humanizer.humanize(now - last.sentAt, {
        round: true,
        largest: 1,
      });
      log.info(`[full-refresh] Skipping ${key} (synced ${ago} ago)`);
      continue;
    }
    log.info(`[full-refresh] Broadcasting ${key}`);
    try {
      const value = await readCurrentValue(config.rpcUrl, feed);
      await sendUpdate(program, feed);
      state[key] = { value: value.toString(), sentAt: now };
      saveState(config.stateFile, state);
    } catch (err) {
      log.error(`[full-refresh] Failed for ${key}:`, err);
    }
  }
}

async function checkAndBroadcast(
  program: Program<MessageEmitter>,
  feeds: FeedEntry[],
  state: BroadcasterState,
): Promise<void> {
  const { changeThreshold } = config;

  for (const feed of feeds) {
    const key = assetIdStr(feed.assetId);
    try {
      const current = await readCurrentValue(config.rpcUrl, feed);
      const last = BigInt(state[key]?.value ?? "0");

      if (!hasChangedBeyondThreshold(current, last, changeThreshold)) {
        continue;
      }

      log.info(`[check] ${key.slice(0, 10)}... changed: ${last} -> ${current}`);
      await sendUpdate(program, feed);
      state[key] = { value: current.toString(), sentAt: Date.now() };
      saveState(config.stateFile, state);
    } catch (err) {
      log.error(`[check] Failed for ${key}:`, err);
    }
  }
}

async function main(): Promise<void> {
  log.info("Broadcaster starting");
  log.info(`  RPC: ${config.rpcUrl}`);
  log.info(`  Program: ${idl.address}`);
  log.info(`  Check interval: ${config.checkIntervalMs / 1_000 / 60}m`);
  log.info(`  Full refresh: ${config.fullRefreshMs / 1_000 / 60 / 60}h`);
  log.info(`  Change threshold: ${config.changeThreshold * 100}%`);
  log.info(`  State file: ${config.stateFile}`);

  const program = buildProgram();
  const feeds = await loadAllFeeds(program);

  if (feeds.length === 0) {
    log.info("No feeds registered, nothing to do");
    process.exit(0);
  }

  const state = loadState(config.stateFile);

  // Initial full refresh on startup
  await broadcastAll(program, feeds, state);
  let lastFullRefresh = Date.now();

  // Periodic check loop
  const tick = async () => {
    const now = Date.now();

    if (now - lastFullRefresh >= config.fullRefreshMs) {
      await broadcastAll(program, feeds, state);
      lastFullRefresh = now;
    } else {
      await checkAndBroadcast(program, feeds, state);
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
