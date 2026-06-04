import type * as anchor from "@coral-xyz/anchor";
import type { wallet } from "@whm/common/evm";

import type { OracleEmitter } from "../../crates/solana/target/types/oracle_emitter";

/** Single-chain EVM wallet context — what each action expects to receive from a step. */
export type WalletContext = ReturnType<typeof wallet.getWallet>;

/** Solana wallet context — what each Solana action expects. */
export interface SolanaContext {
  connection: anchor.web3.Connection;
  keypair: anchor.web3.Keypair;
  wallet: anchor.Wallet;
  provider: anchor.AnchorProvider;
  program: anchor.Program<OracleEmitter>;
}
