import type * as anchor from "@coral-xyz/anchor";
import type { wallet } from "@whm/common";
import type {
  MigrationStep as BS,
  MigrationConfig as BC,
  StepContext as SC,
} from "@whm/common/migration";
import type { OracleEmitter } from "../../../crates/solana/target/types/oracle_emitter";

type EvmWallet = ReturnType<typeof wallet.getWallet>;

export interface SolanaWallet {
  connection: anchor.web3.Connection;
  keypair: anchor.web3.Keypair;
  wallet: anchor.Wallet;
  provider: anchor.AnchorProvider;
  program: anchor.Program<OracleEmitter>;
}

/** Multi-platform wallet context for oracle-relay-solana */
export interface WalletContext {
  moonbeam: EvmWallet;
  solana: SolanaWallet;
}

export type MigrationStep = BS<WalletContext>;
export type MigrationConfig = BC<WalletContext>;
export type StepContext = SC<WalletContext>;
