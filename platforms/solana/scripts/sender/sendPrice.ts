import "dotenv/config";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";

import { args } from "@nohaapav/whm-sdk";

import senderIdl from "../../target/idl/sender.json";
import { Sender } from "../../target/types/sender";

const { requiredEnv, requiredArg } = args;
const { Keypair, PublicKey, Connection } = anchor.web3;

const WORMHOLE_PROGRAM_ID = new PublicKey("worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth");
const SCOPE_ORACLE_PRICES = new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");
const PRIME_ID = new PublicKey("3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7");

function getConfig() {
  const rpcUrl = requiredEnv("RPC_URL");
  const privateKey = requiredArg("--pk");

  return {
    rpcUrl,
    privateKey,
    assetId: PRIME_ID.toBase58(),
    scopePrices: SCOPE_ORACLE_PRICES.toBase58(),
  };
}

function loadKeypair(privateKey: string): anchor.web3.Keypair {
  const decoded = anchor.utils.bytes.bs58.decode(privateKey);
  return Keypair.fromSecretKey(decoded);
}

async function main(): Promise<void> {
  const { rpcUrl, privateKey, assetId, scopePrices } = getConfig();

  const keypair = loadKeypair(privateKey);
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });

  const program = new Program<Sender>(senderIdl, provider);
  const wormholeMessage = Keypair.generate();

  const assetPubkey = new PublicKey(assetId);
  const scopePricesPubkey = new PublicKey(scopePrices);

  const [priceFeed] = PublicKey.findProgramAddressSync(
    [Buffer.from("price_feed"), assetPubkey.toBytes()],
    program.programId,
  );

  const [emitter] = PublicKey.findProgramAddressSync([Buffer.from("emitter")], program.programId);
  const [wormholeSequence] = PublicKey.findProgramAddressSync(
    [Buffer.from("Sequence"), emitter.toBytes()],
    WORMHOLE_PROGRAM_ID,
  );

  console.log("Program ID:", program.programId.toBase58());
  console.log("Payer:", wallet.publicKey.toBase58());
  console.log("Asset ID:", assetPubkey.toBase58());
  console.log("Price Feed PDA:", priceFeed.toBase58());
  console.log("Scope Prices:", scopePricesPubkey.toBase58());

  const tx = await program.methods
    .sendPrice()
    .accountsPartial({
      priceFeed,
      scopePrices: scopePricesPubkey,
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
