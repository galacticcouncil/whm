import * as anchor from "@coral-xyz/anchor";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { SolanaContext } from "../types";
import type { StepOutput } from "@whm/common/migration";

const BPF_LOADER_UPGRADEABLE = new anchor.web3.PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

// ProgramData layout: u32 tag | u64 slot | u8 authority-option | 32-byte authority
const AUTHORITY_OPTION_OFFSET = 12;
const AUTHORITY_OFFSET = 13;

/**
 * Read the current upgrade authority of an upgradeable program.
 *
 * @param connection - Solana RPC connection
 * @param programId - Program whose ProgramData account is inspected
 * @returns Base58 authority, or `null` if the program is already final
 */
async function readUpgradeAuthority(
  connection: anchor.web3.Connection,
  programId: anchor.web3.PublicKey,
): Promise<{ programData: anchor.web3.PublicKey; authority: string | null }> {
  const [programData] = anchor.web3.PublicKey.findProgramAddressSync(
    [programId.toBytes()],
    BPF_LOADER_UPGRADEABLE,
  );

  const account = await connection.getAccountInfo(programData);
  if (!account) throw new Error(`ProgramData account not found: ${programData.toBase58()}`);

  if (account.data[AUTHORITY_OPTION_OFFSET] !== 1) {
    return { programData, authority: null };
  }

  const authority = new anchor.web3.PublicKey(
    account.data.subarray(AUTHORITY_OFFSET, AUTHORITY_OFFSET + 32),
  );

  return { programData, authority: authority.toBase58() };
}

/**
 * IRREVERSIBLY revoke the oracle-emitter program's upgrade authority.
 *
 * After this the bytecode is permanent — no upgrades, no closes, and the
 * ProgramData rent is locked forever. `Config.owner` survives but can only
 * register feeds for asset ids that have never been registered (both
 * register instructions are `init`-only on their PDA seeds), and a renounced
 * OracleReceiver reverts `OracleNotSet` for anything it has no oracle for.
 *
 * Idempotent: a program that is already final returns without submitting.
 *
 * @param params - Solana wallet context; the keypair must be the current upgrade authority
 * @returns Program, ProgramData and the revoked authority
 */
export async function finalize(params: SolanaContext): Promise<StepOutput> {
  const { connection, keypair, program } = params;

  const { programData, authority } = await readUpgradeAuthority(connection, program.programId);

  if (authority === null) {
    console.log("Program already final:", program.programId.toBase58());
    console.log("  ProgramData:", programData.toBase58());

    return {
      programId: program.programId.toBase58(),
      programDataAddress: programData.toBase58(),
      upgradeAuthority: "none",
      revokedAuthority: "none",
    };
  }

  const signer = keypair.publicKey.toBase58();
  if (authority !== signer) {
    throw new Error(
      `Upgrade authority mismatch — cannot finalize.\n` +
        `  Current upgrade authority: ${authority}\n` +
        `  Configured signer (PK_EMITTER): ${signer}`,
    );
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "whm-finalize-"));
  const walletPath = join(tmpDir, "authority.json");
  writeFileSync(walletPath, JSON.stringify(Array.from(keypair.secretKey)));

  try {
    const finalizeArgs = [
      "program",
      "set-upgrade-authority",
      program.programId.toBase58(),
      "--final",
      "--url",
      connection.rpcEndpoint,
      "--keypair",
      walletPath,
      "--upgrade-authority",
      walletPath,
    ];

    console.log("Finalizing program:", program.programId.toBase58());
    console.log("  ProgramData:", programData.toBase58());
    console.log("  Revoking authority:", authority);
    console.log(`> solana ${finalizeArgs.join(" ")}\n`);

    execFileSync("solana", finalizeArgs, { stdio: "inherit" });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // Confirm on-chain rather than trusting the CLI's exit code
  const after = await readUpgradeAuthority(connection, program.programId);
  if (after.authority !== null) {
    throw new Error(`Finalize did not take effect — authority is still ${after.authority}`);
  }

  console.log("Program is now immutable — upgrade authority revoked.");

  return {
    programId: program.programId.toBase58(),
    programDataAddress: programData.toBase58(),
    upgradeAuthority: "none",
    revokedAuthority: authority,
  };
}
