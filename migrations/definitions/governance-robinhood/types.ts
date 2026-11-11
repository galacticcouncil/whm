import type { wallet } from "@whm/common/evm";
import type {
  MigrationConfig as BaseMigrationConfig,
  MigrationStep as BaseMigrationStep,
} from "@whm/common/migration";

type EvmWallet = ReturnType<typeof wallet.getWallet>;

export interface WalletContext {
  robinhood: EvmWallet;
}

export type MigrationStep = BaseMigrationStep<WalletContext>;
export type MigrationConfig = BaseMigrationConfig<WalletContext>;
