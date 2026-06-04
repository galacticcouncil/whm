import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { wallet } from "@whm/common/evm";

import oracleEmitterIdl from "../../../crates/solana/target/idl/oracle_emitter.json";
import type { OracleEmitter } from "../../../crates/solana/target/types/oracle_emitter";

import type { MigrationConfig } from "./types";

/**
 * Oracle relay with Solana as source.
 *
 * Solana emitter publishes Scope oracle prices via Wormhole. Moonbeam dispatcher
 * receives VAAs and forwards to Hydration oracle pallets via XCM transactor.
 *
 * Required PK env vars:
 *   PK_EMITTER — Solana deployer (BS58-encoded keypair)
 *   PK_RELAY   — Moonbeam deployer
 *
 * Env file: migrations/envs/<context>/oracle-relay-solana.env
 */
const config: MigrationConfig = {
  name: "oracle-relay-solana",
  description: "Deploy Solana oracle emitter + Moonbeam relay (dispatcher + transactor)",
  pks: ["PK_EMITTER", "PK_RELAY"],

  setup(env) {
    const required = (k: string) => {
      const v = env[k];
      if (!v) throw new Error(`Missing ${k}`);
      return v;
    };

    // Moonbeam EVM wallet
    const moonbeam = wallet.getWallet(
      required("RPC_MOONBEAM"),
      Number(required("CHAIN_ID_MOONBEAM")),
      env.PK_RELAY as `0x${string}`,
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
      moonbeam,
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
