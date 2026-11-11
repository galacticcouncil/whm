import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Hydration OpenGov -> Ethereum governance route.
 *
 * This migration deploys only the destination executor. The shared Hydration dispatcher is
 * deployed by governance-hydration and supplied here explicitly as configuration.
 *
 * Required PK env vars:
 *   PK_ETHEREUM — Ethereum deployer
 *
 * Env file: migrations/envs/<context>/governance-ethereum.env
 */
const config: MigrationConfig = {
  name: "governance-ethereum",
  description: "Deploy the Ethereum governance executor for the shared Hydration dispatcher",
  pks: ["PK_ETHEREUM"],

  setup(env) {
    const required = (key: string) => {
      const value = env[key];
      if (!value) throw new Error(`Missing ${key}`);
      return value;
    };

    return {
      ethereum: wallet.getWallet(
        required("RPC_ETHEREUM"),
        Number(required("CHAIN_ID_ETHEREUM")),
        env.PK_ETHEREUM as `0x${string}`,
      ),
    };
  },
};

export default config;
