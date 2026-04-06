import * as anchor from "@coral-xyz/anchor";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { SolanaContext } from "../../types";
import type { StepOutput } from "@whm/common/migration";

interface DeployParams extends SolanaContext {
  airdrop?: boolean;
}

export async function deploy(params: DeployParams): Promise<StepOutput> {
  const { connection, keypair, wallet, program, airdrop } = params;

  if (airdrop) {
    console.log("Airdropping 10 SOL to:", wallet.publicKey.toBase58());
    const sig = await connection.requestAirdrop(wallet.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
  }

  // Write temp keypair file for anchor CLI
  const walletPath = join(tmpdir(), `whm-deploy-${Date.now()}.json`);
  writeFileSync(walletPath, JSON.stringify(Array.from(keypair.secretKey)));

  try {
    const deployArgs = [
      "anchor",
      "deploy",
      "--provider.cluster",
      connection.rpcEndpoint,
      "--provider.wallet",
      walletPath,
      "--program-name",
      "message-emitter",
    ];

    console.log(`> ${deployArgs.join(" ")}\n`);
    execSync(deployArgs.join(" "), { stdio: "inherit" });
  } finally {
    unlinkSync(walletPath);
  }

  const programId = program.programId.toBase58();

  const [emitterPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("emitter")],
    program.programId,
  );
  const emitterBytes32 = "0x" + Buffer.from(emitterPda.toBytes()).toString("hex");

  const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  );

  // Initialize config PDA (idempotent)
  const existing = await connection.getAccountInfo(configPda);
  let initializeTx = "";

  if (existing) {
    const data = await program.account.config.fetch(configPda);
    console.log("Config already initialized at:", configPda.toBase58());
    console.log("  Owner:", data.owner.toBase58());
  } else {
    initializeTx = await program.methods
      .initialize()
      .accounts({ owner: wallet.publicKey })
      .rpc();

    console.log("Config initialized:", configPda.toBase58());
    console.log("  Owner:", wallet.publicKey.toBase58());
    console.log("  Tx:", initializeTx);
  }

  return {
    programId,
    emitterPda: emitterPda.toBase58(),
    emitterBytes32,
    configPda: configPda.toBase58(),
    ownerAddress: wallet.publicKey.toBase58(),
    ...(initializeTx ? { initializeTx } : {}),
  };
}
