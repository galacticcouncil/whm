/**
 * Create the 3 Squads-vault ATAs that receive the moxit Wormhole redemptions (SOL/jitoSOL/PRIME).
 * Vault is a PDA (off-curve) → getAssociatedTokenAddressSync(..., allowOwnerOffCurve=true) is required.
 * Idempotent: safe to re-run. ATA creation is permissionless — only the fee-payer needs ~0.006 SOL.
 *
 *   pnpm add @solana/web3.js @solana/spl-token
 *   SOLANA_KEYPAIR=~/funded.json RPC=https://api.mainnet-beta.solana.com npx tsx probes/createSolanaAtas.ts
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";

const VAULT = new PublicKey("EJADfinBBZ49yBMQcRmkCDm5f8Z9M64GpjP4KhfA4JM9");
const MINTS: Record<string, string> = {
  "SOL (wSOL)": "So11111111111111111111111111111111111111112",
  jitoSOL:      "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  PRIME:        "3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7",
};
// expected ATAs (assert derivation matches what's wired into exitAssets.ts)
const EXPECT: Record<string, string> = {
  "SOL (wSOL)": "6H6Y1zwJ8xFFmN7MxQVwnHXHFT4v41VwdhYWDiwF9s24",
  jitoSOL:      "9Wvdk6JpARzTV869YEkLenJUeCULfEox4PmpRT9i9NiE",
  PRIME:        "EsmJrr2f9oufzJKGDeCbCgYTx6Nv7evpz24L12So2KU6",
};

async function main() {
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.SOLANA_KEYPAIR!, "utf8"))));
  const conn = new Connection(process.env.RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");
  console.log("payer:", kp.publicKey.toBase58(), "| vault:", VAULT.toBase58());

  const tx = new Transaction();
  for (const [name, mintStr] of Object.entries(MINTS)) {
    const mint = new PublicKey(mintStr);
    const ata = getAssociatedTokenAddressSync(mint, VAULT, true); // allowOwnerOffCurve = true (vault is a PDA)
    if (ata.toBase58() !== EXPECT[name]) throw new Error(`${name} ATA mismatch: ${ata.toBase58()} != ${EXPECT[name]}`);
    console.log(`  ${name.padEnd(11)} mint ${mintStr}\n  ${"".padEnd(11)} ATA  ${ata.toBase58()}`);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, VAULT, mint));
  }
  const sig = await sendAndConfirmTransaction(conn, tx, [kp]);
  console.log("\n✅ done, sig:", sig);
}
main().catch((e) => { console.error(e); process.exit(1); });
