import * as anchor from "@coral-xyz/anchor";
import type { Program } from "@coral-xyz/anchor";

import type { MessageEmitter } from "./emitter/types.js";
import type { PriceFeedEntry, RateFeedEntry, FeedEntry } from "./feeds.js";
import { assetIdStr } from "./feeds.js";

import log from "./logger.js";

const { PublicKey } = anchor.web3;

const WORMHOLE_PROGRAM_ID = new PublicKey("worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth");
const SHIM_PROGRAM_ID = new PublicKey("EtZMZM22ViKMo4r5y4Anovs3wKQ2owUmDpjygnMMcdEX");

export async function sendUpdate(
  program: Program<MessageEmitter>,
  feed: FeedEntry,
): Promise<string> {
  switch (feed.kind) {
    case "price": {
      return sendPriceUpdate(program, feed);
    }
    case "rate": {
      return sendRateUpdate(program, feed);
    }
    default:
      throw new Error(`Unknown feed kind: ${(feed as any).kind}`);
  }
}

async function sendPriceUpdate(
  program: Program<MessageEmitter>,
  feed: PriceFeedEntry,
): Promise<string> {
  const payer = (program.provider as anchor.AnchorProvider).wallet.publicKey;

  const [emitter] = PublicKey.findProgramAddressSync([Buffer.from("emitter")], program.programId);
  const [message] = PublicKey.findProgramAddressSync([emitter.toBytes()], SHIM_PROGRAM_ID);
  const [sequence] = PublicKey.findProgramAddressSync(
    [Buffer.from("Sequence"), emitter.toBytes()],
    WORMHOLE_PROGRAM_ID,
  );

  const [shimEventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    SHIM_PROGRAM_ID,
  );

  const tx = await program.methods
    .sendPrice()
    .accountsPartial({
      priceFeed: feed.pda,
      scopePrices: feed.scopePrices,
      wormhole: {
        payer,
        message,
        sequence,
        wormholePostMessageShim: SHIM_PROGRAM_ID,
        wormholePostMessageShimEa: shimEventAuthority,
      },
    })
    .rpc();

  log.info(`  sendPrice ${assetIdStr(feed.assetId)} tx: ${tx}`);
  return tx;
}

async function sendRateUpdate(
  program: Program<MessageEmitter>,
  feed: RateFeedEntry,
): Promise<string> {
  const payer = (program.provider as anchor.AnchorProvider).wallet.publicKey;

  const [emitter] = PublicKey.findProgramAddressSync([Buffer.from("emitter")], program.programId);
  const [message] = PublicKey.findProgramAddressSync([emitter.toBytes()], SHIM_PROGRAM_ID);
  const [sequence] = PublicKey.findProgramAddressSync(
    [Buffer.from("Sequence"), emitter.toBytes()],
    WORMHOLE_PROGRAM_ID,
  );

  const [shimEventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    SHIM_PROGRAM_ID,
  );

  const tx = await program.methods
    .sendRate()
    .accountsPartial({
      stakePoolFeed: feed.pda,
      stakePool: feed.stakePool,
      wormhole: {
        payer,
        message,
        sequence,
        wormholePostMessageShim: SHIM_PROGRAM_ID,
        wormholePostMessageShimEa: shimEventAuthority,
      },
    })
    .rpc();

  log.info(`  sendRate ${assetIdStr(feed.assetId)} tx: ${tx}`);
  return tx;
}
