import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Hydration OpenGov -> Base governance route.
 *
 * This migration deploys only the destination executor. The shared Hydration dispatcher is
 * deployed by governance-robinhood and supplied here explicitly as configuration.
 *
 * Required PK env vars:
 *   PK_BASE — Base deployer
 *
 * Env file: migrations/envs/<context>/governance-base.env
 */
const config: MigrationConfig = {
  name: "governance-base",
  description: "Deploy the Base governance executor for the shared Hydration dispatcher",
  pks: ["PK_BASE"],

  setup(env) {
    const required = (key: string) => {
      const value = env[key];
      if (!value) throw new Error(`Missing ${key}`);
      return value;
    };

    return {
      base: wallet.getWallet(
        required("RPC_BASE"),
        Number(required("CHAIN_ID_BASE")),
        env.PK_BASE as `0x${string}`,
      ),
    };
  },
};

export default config;
