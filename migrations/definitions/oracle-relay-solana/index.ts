import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { wallet } from "@whm/common/evm";

import oracleEmitterIdl from "../../../crates/solana/target/idl/oracle_emitter.json";
import type { OracleEmitter } from "../../../crates/solana/target/types/oracle_emitter";

import type { MigrationConfig } from "./types";

/**
 * Oracle relay with Solana as source (direct integration).
 *
 * Solana emitter publishes Scope oracle prices + stake-pool rates via Wormhole.
 * An OracleReceiver on Hydration's EVM verifies the VAA and writes the price
 * straight to the Hydration oracle — no Moonbeam dispatcher / XCM hop.
 *
 * Required PK env vars:
 *   PK_EMITTER  — Solana deployer (BS58-encoded keypair)
 *   PK_RECEIVER — Hydration deployer
 *
 * Env file: migrations/envs/<context>/oracle-relay-solana.env
 */
const config: MigrationConfig = {
  name: "oracle-relay-solana",
  description: "Deploy Solana oracle emitter + Hydration OracleReceiver (direct)",
  pks: ["PK_EMITTER", "PK_RECEIVER"],

  setup(env) {
    const required = (k: string) => {
      const v = env[k];
      if (!v) throw new Error(`Missing ${k}`);
      return v;
    };

    // Hydration EVM wallet
    const hydration = wallet.getWallet(
      required("RPC_HYDRATION"),
      Number(required("CHAIN_ID_HYDRATION")),
      env.PK_RECEIVER as `0x${string}`,
    );

    // Solana Anchor wallet
    const rpcSolana = required("RPC_SOLANA");
    const decoded = anchor.utils.bytes.bs58.decode(env.PK_EMITTER!);
    const keypair = anchor.web3.Keypair.fromSecretKey(decoded);
    const connection = new anchor.web3.Connection(rpcSolana, "confirmed");
    const anchorWallet = new anchor.Wallet(keypair);
    const provider = new anchor.AnchorProvider(connection, anchorWallet, {
      commitment: "confirmed",
    });
    const program = new Program<OracleEmitter>(oracleEmitterIdl as OracleEmitter, provider);

    return {
      hydration,
      solana: {
        connection,
        keypair,
        wallet: anchorWallet,
        provider,
        program,
      },
    };
  },
};

export default config;
