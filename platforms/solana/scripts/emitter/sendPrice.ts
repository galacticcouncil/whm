import "dotenv/config";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";

import { args } from "@whm/common";

import messageEmitterIdl from "../../target/idl/message_emitter.json";
import { MessageEmitter } from "../../target/types/message_emitter";

const { requiredEnv, requiredArg } = args;
const { PublicKey, Connection, Keypair } = anchor.web3;

const WORMHOLE_PROGRAM_ID = new PublicKey("worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth");
const SHIM_PROGRAM_ID = new PublicKey("EtZMZM22ViKMo4r5y4Anovs3wKQ2owUmDpjygnMMcdEX");

const SCOPE_ORACLE_PRICES = new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");

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

  const assetPubkey = new PublicKey(assetId);

  const [priceFeed] = PublicKey.findProgramAddressSync(
    [Buffer.from("price_feed"), assetPubkey.toBytes()],
    program.programId,
  );

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

  console.log("Program ID:", program.programId.toBase58());
  console.log("Payer:", wallet.publicKey.toBase58());
  console.log("Asset ID:", assetPubkey.toBase58());
  console.log("Price Feed PDA:", priceFeed.toBase58());

  const tx = await program.methods
    .sendPrice()
    .accountsPartial({
      priceFeed,
      scopePrices: SCOPE_ORACLE_PRICES,
      wormhole: {
        payer: wallet.publicKey,
        message,
        sequence,
        wormholePostMessageShim: SHIM_PROGRAM_ID,
        wormholePostMessageShimEa: shimEventAuthority,
      },
    })
    .rpc();

  console.log("Tx:", tx);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
