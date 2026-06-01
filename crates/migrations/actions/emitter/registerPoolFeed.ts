import * as anchor from "@coral-xyz/anchor";

import type { SolanaContext } from "../../types";
import type { StepOutput } from "@whm/common/migration";

interface RegisterPoolFeedParams extends SolanaContext {
  /** Solana public key of the asset (base58) */
  assetId: string;
  /** SPL Stake Pool address (base58) */
  stakePool: string;
}

export async function registerPoolFeed(params: RegisterPoolFeedParams): Promise<StepOutput> {
  const { connection, wallet, program, assetId, stakePool } = params;

  const assetPubkey = new anchor.web3.PublicKey(assetId);
  const stakePoolPubkey = new anchor.web3.PublicKey(stakePool);
  const assetIdBytes = Array.from(assetPubkey.toBytes());
  const assetIdBytes32 = "0x" + Buffer.from(assetPubkey.toBytes()).toString("hex");

  const [poolFeedPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("stake_pool_feed"), Buffer.from(assetIdBytes)],
    program.programId,
  );

  // Idempotent — skip if already registered
  const existing = await connection.getAccountInfo(poolFeedPda);
  if (existing) {
    const data = await program.account.stakePoolFeed.fetch(poolFeedPda);
    console.log("Pool feed already registered at:", poolFeedPda.toBase58());
    console.log("  assetId:", assetId);
    console.log("  stakePool:", data.stakePool.toBase58());

    return {
      poolFeedPda: poolFeedPda.toBase58(),
      assetId,
      assetIdBytes32,
      stakePool: data.stakePool.toBase58(),
    };
  }

  const tx = await program.methods
    .registerPoolFeed(assetIdBytes, stakePoolPubkey)
    .accounts({ owner: wallet.publicKey })
    .rpc();

  console.log("Pool feed registered:", poolFeedPda.toBase58());
  console.log("  assetId:", assetId);
  console.log("  assetId (bytes32):", assetIdBytes32);
  console.log("  stakePool:", stakePool);
  console.log("  Tx:", tx);

  return {
    poolFeedPda: poolFeedPda.toBase58(),
    assetId,
    assetIdBytes32,
    stakePool,
    tx,
  };
}
