import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Hydration OpenGov -> Robinhood Chain governance route.
 *
 * This migration deploys only the destination executor. The shared Hydration dispatcher is
 * deployed independently by governance-hydration and supplied here as explicit configuration.
 *
 * Required PK env vars:
 *   PK_ROBINHOOD — Robinhood deployer
 *
 * Env file: migrations/envs/<context>/governance-robinhood.env
 */
const config: MigrationConfig = {
  name: "governance-robinhood",
  description: "Deploy the Robinhood governance executor for the shared Hydration dispatcher",
  pks: ["PK_ROBINHOOD"],

  setup(env) {
    const required = (key: string) => {
      const value = env[key];
      if (!value) throw new Error(`Missing ${key}`);
      return value;
    };

    return {
      robinhood: wallet.getWallet(
        required("RPC_ROBINHOOD"),
        Number(required("CHAIN_ID_ROBINHOOD")),
        env.PK_ROBINHOOD as `0x${string}`,
      ),
    };
  },
};

export default config;
