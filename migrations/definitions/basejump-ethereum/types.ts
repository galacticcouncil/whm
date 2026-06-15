import type { wallet } from "@whm/common/evm";
import type {
  MigrationStep as BS,
  MigrationConfig as BC,
  StepContext as SC,
} from "@whm/common/migration";

type EvmWallet = ReturnType<typeof wallet.getWallet>;

/** Multi-chain wallet context for basejump-ethereum deployment */
export interface WalletContext {
  moonbeam: EvmWallet;
  ethereum: EvmWallet;
}

export type MigrationStep = BS<WalletContext>;
export type MigrationConfig = BC<WalletContext>;
export type StepContext = SC<WalletContext>;
