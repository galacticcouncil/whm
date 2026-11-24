import type { wallet } from "@whm/common/evm";
import type { wallet as nearWallet } from "@whm/common/near";
import type {
  MigrationStep as BS,
  MigrationConfig as BC,
  StepContext as SC,
} from "@whm/common/migration";

type EvmWallet = ReturnType<typeof wallet.getWallet>;

/** All three chains: the dispatcher on Hydration, the forwarder on Ethereum, the router on NEAR. */
export interface WalletContext {
  hydration: EvmWallet;
  ethereum: EvmWallet;
  near: nearWallet.NearWallet;
}

export type MigrationStep = BS<WalletContext>;
export type MigrationConfig = BC<WalletContext>;
export type StepContext = SC<WalletContext>;
