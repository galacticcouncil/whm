import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";

import idl from "../emitter/idl.json";
import type { OracleEmitter } from "../emitter/types.js";

import { loadAllFeeds, assetIdStr, type FeedEntry } from "../feeds.js";
import { readCurrentValue } from "../reader.js";
import { sendUpdate } from "../sender.js";
import { loadKeypair } from "../utils.js";

import log from "../logger.js";
import type { ChainAdapter, Feed } from "./types.js";

interface SolanaConfig {
  rpcUrl: string;
  privateKey: string;
}

type SolanaFeed = Feed & { entry: FeedEntry };

function buildProgram(cfg: SolanaConfig): Program<OracleEmitter> {
  const keypair = loadKeypair(cfg.privateKey);
  const connection = new anchor.web3.Connection(cfg.rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return new Program<OracleEmitter>(idl as OracleEmitter, provider);
}

export function createSolanaAdapter(cfg: SolanaConfig): ChainAdapter {
  const program = buildProgram(cfg);
  log.info(`  [solana] program: ${idl.address}`);

  return {
    name: "solana",

    async loadFeeds() {
      const entries = await loadAllFeeds(program);
      return entries.map((entry) => {
        const key = assetIdStr(entry.assetId);
        return { key, label: key, entry } satisfies SolanaFeed;
      });
    },

    read: (feed) => readCurrentValue(cfg.rpcUrl, (feed as SolanaFeed).entry),
    send: (feed) => sendUpdate(program, (feed as SolanaFeed).entry),
  };
}
