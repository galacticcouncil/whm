import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Intents — Hydration IntentEmitter (WTT variant) stand-up + path wiring.
 *
 * Deploys the Hydration-side entry point, authorizes its XCM operator, and wires the WTT path:
 * the Moonbeam Wormhole TokenBridge (the MDA calls it to bridge WETH) and the Ethereum
 * IntentReceiver (the payload-3 recipient that redeems on the far side).
 *
 *   001 deploy IntentEmitterWtt (UUPS proxy) on Hydration
 *   002 set XCM operator @emitter
 *   003 set Moonbeam TokenBridge @emitter
 *   004 set Ethereum IntentReceiver @emitter
 *
 * Required PK env var:
 *   PK — Hydration deployer
 *
 * Env file: migrations/envs/<context>/nintent-ethereum.env
 */
const config: MigrationConfig = {
  name: "nintent-ethereum",
  description:
    "Deploy the Hydration IntentEmitter (WTT), authorize the XCM operator + wire the WTT path",
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
