import type { wallet } from "@whm/common/evm";
import type { wallet as nearWallet } from "@whm/common/near";
import type {
  MigrationStep as BS,
  MigrationConfig as BC,
  StepContext as SC,
} from "@whm/common/migration";

type EvmWallet = ReturnType<typeof wallet.getWallet>;

/** The dispatcher on Hydration and the router on NEAR, each still owned by its deployer. */
export interface WalletContext {
  hydration: EvmWallet;
  near: nearWallet.NearWallet;
}

export type MigrationStep = BS<WalletContext>;
export type MigrationConfig = BC<WalletContext>;
export type StepContext = SC<WalletContext>;
