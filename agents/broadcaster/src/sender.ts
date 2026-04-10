import * as anchor from "@coral-xyz/anchor";
import type { Program } from "@coral-xyz/anchor";

import type { MessageEmitter } from "./emitter/types.js";
import type { PriceFeedEntry, RateFeedEntry, FeedEntry } from "./feeds.js";
import { assetIdStr } from "./feeds.js";
import log from "./logger.js";

const { Keypair, PublicKey } = anchor.web3;

const WORMHOLE_PROGRAM_ID = new PublicKey("worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth");

export async function sendUpdate(
  program: Program<MessageEmitter>,
  feed: FeedEntry,
): Promise<string> {
  if (feed.kind === "price") {
    return sendPriceUpdate(program, feed);
  }
  return sendRateUpdate(program, feed);
}

async function sendPriceUpdate(
  program: Program<MessageEmitter>,
  feed: PriceFeedEntry,
): Promise<string> {
  const wormholeMessage = Keypair.generate();
  const payer = (program.provider as anchor.AnchorProvider).wallet.publicKey;
  const [emitter] = PublicKey.findProgramAddressSync([Buffer.from("emitter")], program.programId);
  const [wormholeSequence] = PublicKey.findProgramAddressSync(
    [Buffer.from("Sequence"), emitter.toBytes()],
    WORMHOLE_PROGRAM_ID,
  );

  const tx = await program.methods
    .sendPrice()
    .accountsPartial({
      priceFeed: feed.pda,
      scopePrices: feed.scopePrices,
      wormhole: {
        payer,
        wormholeMessage: wormholeMessage.publicKey,
        wormholeSequence,
      },
    })
    .signers([wormholeMessage])
    .rpc();

  log.info(`  sendPrice ${assetIdStr(feed.assetId)} tx: ${tx}`);
  return tx;
}

async function sendRateUpdate(
  program: Program<MessageEmitter>,
  feed: RateFeedEntry,
): Promise<string> {
  const wormholeMessage = Keypair.generate();
  const payer = (program.provider as anchor.AnchorProvider).wallet.publicKey;
  const [emitter] = PublicKey.findProgramAddressSync([Buffer.from("emitter")], program.programId);
  const [wormholeSequence] = PublicKey.findProgramAddressSync(
    [Buffer.from("Sequence"), emitter.toBytes()],
    WORMHOLE_PROGRAM_ID,
  );

  const tx = await program.methods
    .sendRate()
    .accountsPartial({
      stakePoolFeed: feed.pda,
      stakePool: feed.stakePool,
      wormhole: {
        payer,
        wormholeMessage: wormholeMessage.publicKey,
        wormholeSequence,
      },
    })
    .signers([wormholeMessage])
    .rpc();

  log.info(`  sendRate ${assetIdStr(feed.assetId)} tx: ${tx}`);
  return tx;
}
