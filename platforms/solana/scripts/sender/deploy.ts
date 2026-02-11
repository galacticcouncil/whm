import "dotenv/config";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";

import { args } from "@nohaapav/whm-sdk";

import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import senderIdl from "../../target/idl/sender.json";
import { Sender } from "../../target/types/sender";

const { requiredEnv, requiredArg, optionalArg } = args;

const { PublicKey, Keypair, Connection } = anchor.web3;

function getConfig() {
  const rpcUrl = requiredEnv("RPC_URL");

  const privateKey = requiredArg("--pk");
  const isTest = optionalArg("--test");

  return {
    rpcUrl,
    privateKey: privateKey,
    isTest: Boolean(isTest),
  };
}

function loadKeypair(privateKey: string): anchor.web3.Keypair {
  const decoded = anchor.utils.bytes.bs58.decode(privateKey);
  return Keypair.fromSecretKey(decoded);
}

async function airdrop(connection: anchor.web3.Connection, wallet: anchor.Wallet) {
  console.log("Airdropping 10 SOL to:", wallet.publicKey.toBase58());
  const sig = await connection.requestAirdrop(wallet.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
}

async function main(): Promise<void> {
  const { isTest, rpcUrl, privateKey } = getConfig();

  const keypair = loadKeypair(privateKey);

  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });

  if (isTest) {
    await airdrop(connection, wallet);
  }

  const walletPath = join(tmpdir(), `whm-deploy-${Date.now()}.json`);
  writeFileSync(walletPath, JSON.stringify(Array.from(keypair.secretKey)));

  try {
    const deployArgs = [
      "anchor",
      "deploy",
      "--provider.cluster",
      rpcUrl,
      "--provider.wallet",
      walletPath,
      "--program-name",
      "sender",
    ];

    console.log(`> ${deployArgs.join(" ")}\n`);
    execSync(deployArgs.join(" "), { stdio: "inherit" });
  } finally {
    unlinkSync(walletPath);
  }

  const program = new Program<Sender>(senderIdl, provider);
  console.log("Program ID:", program.programId.toBase58());

  const [emitterPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("emitter")],
    program.programId,
  );
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
