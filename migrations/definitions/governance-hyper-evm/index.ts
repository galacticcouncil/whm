import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Hydration OpenGov -> HyperEVM governance route.
 *
 * This migration deploys only the destination executor. The shared Hydration dispatcher is
 * deployed by governance-hydration and supplied here explicitly as configuration.
 *
 * Required PK env vars:
 *   PK_HYPEREVM — HyperEVM deployer
 *
 * Env file: migrations/envs/<context>/governance-hyper-evm.env
 */
const config: MigrationConfig = {
  name: "governance-hyper-evm",
  description: "Deploy the HyperEVM governance executor for the shared Hydration dispatcher",
  pks: ["PK_HYPEREVM"],

  setup(env) {
    const required = (key: string) => {
      const value = env[key];
      if (!value) throw new Error(`Missing ${key}`);
      return value;
    };

    return {
      hyperEvm: wallet.getWallet(
        required("RPC_HYPEREVM"),
        Number(required("CHAIN_ID_HYPEREVM")),
        env.PK_HYPEREVM as `0x${string}`,
      ),
    };
  },
};

export default config;
