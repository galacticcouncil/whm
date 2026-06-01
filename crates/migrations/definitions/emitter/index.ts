import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";

import type { MigrationConfig } from "../../types";
import messageEmitterIdl from "../../../target/idl/message_emitter.json";
import type { MessageEmitter } from "../../../target/types/message_emitter";

/**
 * Solana message-emitter deployment:
 *   Deploy program → initialize config → register asset price feeds
 *
 * Env file: migrations/envs/{env}/emitter.env
 */
const config: MigrationConfig = {
  name: "emitter",
  description: "Deploy and configure Solana message emitter",

  setup: (env, pk) => {
    const rpcUrl = env.RPC_URL;
    if (!rpcUrl) throw new Error("Missing RPC_URL");

    const decoded = anchor.utils.bytes.bs58.decode(pk);
    const keypair = anchor.web3.Keypair.fromSecretKey(decoded);

    const connection = new anchor.web3.Connection(rpcUrl, "confirmed");
    const wallet = new anchor.Wallet(keypair);
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
    const program = new Program<MessageEmitter>(messageEmitterIdl as MessageEmitter, provider);

    return { connection, keypair, wallet, provider, program };
  },
};

export default config;
