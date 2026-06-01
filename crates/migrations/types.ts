import type {
  StepContext as BaseStepContext,
  MigrationStep as BaseMigrationStep,
  MigrationConfig as BaseMigrationConfig,
  Migration as BaseMigration,
} from "@whm/common/migration";
import type * as anchor from "@coral-xyz/anchor";
import type { MessageEmitter } from "../target/types/message_emitter";

export interface SolanaContext {
  connection: anchor.web3.Connection;
  keypair: anchor.web3.Keypair;
  wallet: anchor.Wallet;
  provider: anchor.AnchorProvider;
  program: anchor.Program<MessageEmitter>;
}

// Narrow generic types to Solana context
export type StepContext = BaseStepContext<SolanaContext>;
export type MigrationStep = BaseMigrationStep<SolanaContext>;
export type MigrationConfig = BaseMigrationConfig<SolanaContext>;
export type Migration = BaseMigration<SolanaContext>;

// Re-export non-generic types as-is
export type { StepOutput, StepState, MigrationState } from "@whm/common/migration";
