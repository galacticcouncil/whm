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
  const message = requiredArg("--message");

  return {
    rpcUrl,
    privateKey,
    message,
  };
}

function loadKeypair(privateKey: string): anchor.web3.Keypair {
  const decoded = anchor.utils.bytes.bs58.decode(privateKey);
  return Keypair.fromSecretKey(decoded);
}

async function main(): Promise<void> {
  const { rpcUrl, privateKey, message } = getConfig();

  const keypair = loadKeypair(privateKey);
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });

  const program = new Program<MessageEmitter>(messageEmitterIdl, provider);
  const wormholeMessage = Keypair.generate();

  const [emitter] = PublicKey.findProgramAddressSync([Buffer.from("emitter")], program.programId);
  const [wormholeSequence] = PublicKey.findProgramAddressSync(
    [Buffer.from("Sequence"), emitter.toBytes()],
    WORMHOLE_PROGRAM_ID,
  );

  console.log("Program ID:", program.programId.toBase58());
  console.log("Payer:", wallet.publicKey.toBase58());
  console.log("Message:", message);

  const tx = await program.methods
    .sendMessage(message)
    .accounts({
      payer: wallet.publicKey,
      wormholeMessage: wormholeMessage.publicKey,
      wormholeSequence,
    })
    .signers([wormholeMessage])
    .rpc();

  console.log("Tx:", tx);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
