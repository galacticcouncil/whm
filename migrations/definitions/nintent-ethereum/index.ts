import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Intents — Hydration IntentEmitter (WTT variant), minimal stand-up.
 *
 * Deploys the Hydration-side entry point and authorizes its XCM operator — nothing else.
 * Path wiring (setTokenBridge / setIntentReceiver) is intentionally left out of this migration.
 *
 *   001 deploy IntentEmitterWtt (UUPS proxy) on Hydration
 *   002 set XCM operator @emitter
 *
 * Required PK env var:
 *   PK — Hydration deployer
 *
 * Env file: migrations/envs/<context>/nintent-ethereum.env
 */
const config: MigrationConfig = {
  name: "nintent-ethereum",
  description: "Deploy the Hydration IntentEmitter (WTT) + authorize the XCM operator",
  pks: ["PK"],

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
        env.PK as `0x${string}`,
      ),
    };
  },
};

export default config;
