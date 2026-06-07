import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * NEAR Intents — IntentEmitter deployment on Hydration.
 *
 * Minimal first cut: deploys the IntentEmitter UUPS proxy (impl + ERC1967Proxy +
 * initialize). Intended for fork testing against an anvil fork of Hydration.
 *
 * Required PK env vars:
 *   PK_EMITTER — Hydration deployer
 *
 * Env file: migrations/envs/<context>/nintent-ethereum.env
 */
const config: MigrationConfig = {
  name: "nintent-ethereum",
  description: "Deploy IntentEmitter (NEAR Intents) on Hydration",
  pks: ["PK_EMITTER"],

  setup(env) {
    const required = (k: string) => {
      const v = env[k];
      if (!v) throw new Error(`Missing ${k}`);
      return v;
    };

    return {
      hydration: wallet.getWallet(
        required("RPC_HYDRATION"),
        Number(required("CHAIN_ID_HYDRATION")),
        env.PK_EMITTER as `0x${string}`,
      ),
    };
  },
};

export default config;
