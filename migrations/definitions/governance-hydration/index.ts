import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Shared Hydration source for cross-chain governance.
 *
 * This migration deploys the GovernanceDispatcher independently of any destination executor.
 * Every destination migration receives its proxy address through explicit environment config.
 *
 * Required PK env vars:
 *   PK_HYDRATION — Hydration deployer (must hold an EVMAccounts.ContractDeployer slot)
 *
 * Env file: migrations/envs/<context>/governance-hydration.env
 */
const config: MigrationConfig = {
  name: "governance-hydration",
  description: "Deploy the shared cross-chain governance dispatcher on Hydration",
  pks: ["PK_HYDRATION"],

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
    };
  },
};

export default config;
