import * as anchor from "@coral-xyz/anchor";

import type { SolanaContext } from "../../types";
import type { StepOutput } from "@whm/common/migration";

interface RegisterAssetParams extends SolanaContext {
  /** Solana public key of the asset (base58) */
  assetId: string;
  /** Scope oracle price index */
  priceIndex: number;
}

export async function registerAsset(params: RegisterAssetParams): Promise<StepOutput> {
  const { connection, wallet, program, assetId, priceIndex } = params;

  const assetPubkey = new anchor.web3.PublicKey(assetId);
  const assetIdBytes = Array.from(assetPubkey.toBytes());
  const assetIdBytes32 = "0x" + Buffer.from(assetPubkey.toBytes()).toString("hex");

  const [priceFeedPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("price_feed"), Buffer.from(assetIdBytes)],
    program.programId,
  );

  // Idempotent — skip if already registered
  const existing = await connection.getAccountInfo(priceFeedPda);
  if (existing) {
    const data = await program.account.priceFeed.fetch(priceFeedPda);
    console.log("Price feed already registered at:", priceFeedPda.toBase58());
    console.log("  assetId:", assetId);
    console.log("  priceIndex:", data.priceIndex);

    return {
      priceFeedPda: priceFeedPda.toBase58(),
      assetId,
      assetIdBytes32,
      priceIndex: String(data.priceIndex),
    };
  }

  const tx = await program.methods
    .registerPriceFeed(assetIdBytes, priceIndex)
    .accounts({ owner: wallet.publicKey })
    .rpc();

  console.log("Price feed registered:", priceFeedPda.toBase58());
  console.log("  assetId:", assetId);
  console.log("  assetId (bytes32):", assetIdBytes32);
  console.log("  priceIndex:", priceIndex);
  console.log("  Tx:", tx);

  return {
    priceFeedPda: priceFeedPda.toBase58(),
    assetId,
    assetIdBytes32,
    priceIndex: String(priceIndex),
    tx,
  };
}
