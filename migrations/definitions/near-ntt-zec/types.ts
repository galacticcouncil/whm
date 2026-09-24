import type { wallet as nearWallet } from "@whm/common/near";
import type {
  MigrationStep as BS,
  MigrationConfig as BC,
  StepContext as SC,
} from "@whm/common/migration";

/** NEAR only — the Hydration side is deployed and peered from hydration-ntt. */
export interface WalletContext {
  near: nearWallet.NearWallet;
}

export type MigrationStep = BS<WalletContext>;
export type MigrationConfig = BC<WalletContext>;
export type StepContext = SC<WalletContext>;
