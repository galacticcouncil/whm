import "dotenv/config";

import * as anchor from "@coral-xyz/anchor";

import { args } from "@nohaapav/whm-sdk";

import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { requiredEnv, requiredArg, optionalArg } = args;
const { PublicKey, Keypair } = anchor.web3;

function getConfig() {
  const rpcUrl = requiredEnv("RPC_URL");
  const privateKey = requiredArg("--pk");
  const recipient = optionalArg("--recipient");

  return {
    rpcUrl,
    privateKey,
    recipient,
  };
}

function loadKeypair(privateKey: string): anchor.web3.Keypair {
  const decoded = anchor.utils.bytes.bs58.decode(privateKey);
  return Keypair.fromSecretKey(decoded);
}

async function main(): Promise<void> {
  const { rpcUrl, privateKey, recipient } = getConfig();

  const authority = loadKeypair(privateKey);
  const recipientPubkey = recipient ? new PublicKey(recipient) : authority.publicKey;

  const tmpDir = mkdtempSync(join(tmpdir(), "whm-cleanup-"));
  const walletPath = join(tmpDir, "authority.json");
  writeFileSync(walletPath, JSON.stringify(Array.from(authority.secretKey)));

  try {
    const cleanupArgs = [
      "program",
      "close",
      "--buffers",
      "--url",
      rpcUrl,
      "--authority",
      walletPath,
      "--keypair",
      walletPath,
      "--recipient",
      recipientPubkey.toBase58(),
    ];

    console.log("Closing deploy buffers for authority:", authority.publicKey.toBase58());
    console.log("Recipient:", recipientPubkey.toBase58());
    console.log(`> solana ${cleanupArgs.join(" ")}\n`);

    execFileSync("solana", cleanupArgs, { stdio: "inherit" });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
