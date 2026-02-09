import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";

import { readFileSync } from "fs";
import { execSync } from "child_process";

import senderIdl from "../target/idl/sender.json";
import { Sender } from "../target/types/sender";

const { PublicKey, Keypair, Connection } = anchor.web3;

const RPC_URL = "http://127.0.0.1:8898";

function loadKeypair(): InstanceType<typeof Keypair> {
  const home = process.env.HOME!;
  const defaultPath = `${home}/.config/solana/id.json`;
  const secretKey = JSON.parse(readFileSync(defaultPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

async function main(): Promise<void> {
  const keypair = loadKeypair();
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });

  console.log("Airdropping 10 SOL to:", wallet.publicKey.toBase58());
  const sig = await connection.requestAirdrop(wallet.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });

  const deployArgs = [
    "anchor",
    "deploy",
    "--provider.cluster",
    RPC_URL,
    "--program-name",
    "sender",
  ];

  console.log(`> ${deployArgs.join(" ")}\n`);
  execSync(deployArgs.join(" "), { stdio: "inherit" });

  const program = new Program<Sender>(senderIdl, provider);
  console.log("Program ID:", program.programId.toBase58());

  const [emitterPda] = PublicKey.findProgramAddressSync([Buffer.from("emitter")], program.programId);
  console.log("Emitter PDA:", emitterPda.toBase58());
  console.log("Emitter (bytes32):", "0x" + Buffer.from(emitterPda.toBytes()).toString("hex"));

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);

  const existing = await connection.getAccountInfo(configPda);
  if (existing) {
    const data = await program.account.config.fetch(configPda);
    console.log("Config already initialized at:", configPda.toBase58());
    console.log("  Owner:", data.owner.toBase58());
    return;
  }

  const tx = await program.methods
    .initialize()
    .accounts({
      owner: wallet.publicKey,
    })
    .rpc();

  console.log("Config initialized:", configPda.toBase58());
  console.log("  Owner:", wallet.publicKey.toBase58());
  console.log("  Tx:", tx);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
