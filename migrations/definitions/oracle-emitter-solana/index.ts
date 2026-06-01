import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";

import type { MigrationConfig } from "../../solana";
import oracleEmitterIdl from "../../../crates/target/idl/oracle_emitter.json";
import type { OracleEmitter } from "../../../crates/target/types/oracle_emitter";

/**
 * Solana oracle-emitter deployment:
 *   Deploy program → initialize config → register asset price feeds
 *
 * Env file: migrations/envs/{env}/emitter.env
 */
const config: MigrationConfig = {
  name: "oracle-emitter-solana",
  description: "Deploy and configure Solana message emitter",

  setup: (env, pk) => {
    const rpcUrl = env.RPC_URL;
    if (!rpcUrl) throw new Error("Missing RPC_URL");

    const decoded = anchor.utils.bytes.bs58.decode(pk);
    const keypair = anchor.web3.Keypair.fromSecretKey(decoded);

    const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
    const wallet = new anchor.Wallet(keypair);
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
    const program = new Program<OracleEmitter>(oracleEmitterIdl as OracleEmitter, provider);

    return { connection, keypair, wallet, provider, program };
  },
};

export default config;
