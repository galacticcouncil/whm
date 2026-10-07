import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * First cross-chain governance route: Hydration OpenGov -> Robinhood Chain.
 *
 * The dispatcher is the shared Hydration source for every future destination. It is deployed here
 * because Robinhood is the first route; later destination migrations must take its proxy address
 * from this migration's production state as explicit environment configuration rather than deploy
 * another dispatcher.
 *
 * Both proxies initialize atomically. The deployer has no authority after deployment: dispatcher
 * publication/upgrades require the synthetic OpenGov caller, while executor administration and
 * upgrades require an executed governance or delayed Technical Committee action.
 *
 * Required PK env vars:
 *   PK_HYDRATION — Hydration deployer (must hold an EVMAccounts.ContractDeployer slot)
 *   PK_ROBINHOOD — Robinhood deployer
 *
 * Env file: migrations/envs/<context>/governance-robinhood.env
 */
const config: MigrationConfig = {
  name: "governance-robinhood",
  description: "Deploy the Hydration governance dispatcher and Robinhood governance executor",
  pks: ["PK_HYDRATION", "PK_ROBINHOOD"],

  setup(env) {
    const required = (key: string) => {
      const value = env[key];
      if (!value) throw new Error(`Missing ${key}`);
      return value;
    };

    return {
      hydration: wallet.getWallet(
        required("RPC_HYDRATION"),
        Number(required("CHAIN_ID_HYDRATION")),
        env.PK_HYDRATION as `0x${string}`,
      ),
      robinhood: wallet.getWallet(
        required("RPC_ROBINHOOD"),
        Number(required("CHAIN_ID_ROBINHOOD")),
        env.PK_ROBINHOOD as `0x${string}`,
      ),
    };
  },
};

export default config;
