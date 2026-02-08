import "dotenv/config";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";

import { readFileSync } from "fs";

import messageSenderJson from "../target/idl/sender.json";

import { Sender } from "../target/types/sender";

const { PublicKey, Keypair, Connection } = anchor.web3;

function loadKeypair(): InstanceType<typeof Keypair> {
  const accountPk = process.env.ACCOUNT_PK;
  const keypairPath = process.env.SOLANA_KEYPAIR;

  // Base58 private key (e.g. exported from Phantom)
  if (accountPk) {
    const decoded = anchor.utils.bytes.bs58.decode(accountPk);
    return Keypair.fromSecretKey(decoded);
  }

  // JSON keypair file (e.g. ~/.config/solana/id.json)
  if (keypairPath) {
    const resolvedPath = keypairPath.replace("~", process.env.HOME!);
    const secretKey = JSON.parse(readFileSync(resolvedPath, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(secretKey));
  }

  throw new Error("Missing account info. Provide ACCOUNT_PK or SOLANA_KEYPAIR.");
}

function getConfig() {
  const rpcUrl = process.env.SOLANA_RPC;
  const wormholeProgramId = process.env.WORMHOLE_PROGRAM_ID;

  if (!rpcUrl) throw new Error("Missing SOLANA_RPC.");
  if (!wormholeProgramId) throw new Error("Missing WORMHOLE_PROGRAM_ID.");

  const keypair = loadKeypair();

  return {
    rpcUrl,
    keypair,
    wormholeProgramId: new PublicKey(wormholeProgramId),
  };
}

async function main(): Promise<void> {
  const config = getConfig();

  const connection = new Connection(config.rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(config.keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });

  const idl = messageSenderJson;
  const program = new Program<Sender>(idl, provider);

  console.log("Program ID:", program.programId.toBase58());

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);

  // Check if already initialized
  const existing = await connection.getAccountInfo(configPda);
  if (existing) {
    const data = await program.account.config.fetch(configPda);
    console.log("Config already initialized at:", configPda.toBase58());
    console.log("  Owner:", data.owner.toBase58());
    console.log("  Wormhole:", data.wormhole.toBase58());
    return;
  }

  const tx = await program.methods
    .initialize()
    .accounts({
      owner: wallet.publicKey,
      wormholeProgram: config.wormholeProgramId,
    })
    .rpc();

  console.log("Config initialized:", configPda.toBase58());
  console.log("  Owner:", wallet.publicKey.toBase58());
  console.log("  Wormhole:", config.wormholeProgramId.toBase58());
  console.log("  Tx:", tx);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
