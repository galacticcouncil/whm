import "dotenv/config";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";

import { args } from "@whm/common";

import messageEmitterIdl from "../../target/idl/message_emitter.json";
import { MessageEmitter } from "../../target/types/message_emitter";

const { requiredEnv, requiredArg } = args;
const { Keypair, PublicKey, Connection } = anchor.web3;

const WORMHOLE_PROGRAM_ID = new PublicKey("worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth");

function getConfig() {
  const rpcUrl = requiredEnv("RPC_URL");
  const privateKey = requiredArg("--pk");
  const assetId = requiredArg("--asset");

  return { rpcUrl, privateKey, assetId };
}

function loadKeypair(privateKey: string): anchor.web3.Keypair {
  const decoded = anchor.utils.bytes.bs58.decode(privateKey);
  return Keypair.fromSecretKey(decoded);
}

async function main(): Promise<void> {
  const { rpcUrl, privateKey, assetId } = getConfig();

  const keypair = loadKeypair(privateKey);
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });

  const program = new Program<MessageEmitter>(messageEmitterIdl, provider);
  const wormholeMessage = Keypair.generate();

  const assetPubkey = new PublicKey(assetId);

  const [stakePoolFeed] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake_pool_feed"), assetPubkey.toBytes()],
    program.programId,
  );

  // Resolve stake pool address from on-chain PDA
  const feedData = await program.account.stakePoolFeed.fetch(stakePoolFeed);

  const [emitter] = PublicKey.findProgramAddressSync([Buffer.from("emitter")], program.programId);
  const [wormholeSequence] = PublicKey.findProgramAddressSync(
    [Buffer.from("Sequence"), emitter.toBytes()],
    WORMHOLE_PROGRAM_ID,
  );

  console.log("Program ID:", program.programId.toBase58());
  console.log("Payer:", wallet.publicKey.toBase58());
  console.log("Asset ID:", assetPubkey.toBase58());
  console.log("Pool Feed PDA:", stakePoolFeed.toBase58());
  console.log("Stake Pool:", feedData.stakePool.toBase58());

  const tx = await program.methods
    .sendRate()
    .accountsPartial({
      stakePoolFeed,
      stakePool: feedData.stakePool,
      wormhole: {
        payer: wallet.publicKey,
        wormholeMessage: wormholeMessage.publicKey,
        wormholeSequence,
      },
    })
    .signers([wormholeMessage])
    .rpc();

  console.log("Tx:", tx);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
