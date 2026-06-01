import type {
  StepContext as BaseStepContext,
  MigrationStep as BaseMigrationStep,
  MigrationConfig as BaseMigrationConfig,
  Migration as BaseMigration,
} from "@whm/common/migration";
import type { wallet } from "../lib";

export type WalletContext = ReturnType<typeof wallet.getWallet>;

// Narrow generic types to EVM wallet
export type StepContext = BaseStepContext<WalletContext>;
export type MigrationStep = BaseMigrationStep<WalletContext>;
export type MigrationConfig = BaseMigrationConfig<WalletContext>;
export type Migration = BaseMigration<WalletContext>;

// Re-export non-generic types as-is
export type { StepOutput, StepState, MigrationState } from "@whm/common/migration";
