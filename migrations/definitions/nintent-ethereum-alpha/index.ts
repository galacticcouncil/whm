import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Intents — ALPHA: the Moonbeam → Ethereum (2nd) leg only, for testing without Hydration.
 *
 * Deploys + wires everything from the Moonbeam BasejumpProxy onward:
 *   - Moonbeam : BasejumpProxy (bridgeViaWormhole → TokenBridge slow + fast VAA)
 *   - Ethereum : Basejump (inbound completion) + BasejumpLandingNative (native-ETH pool)
 *                + IntentRouter (forwards native ETH to the OneClick depositAddress)
 *
 * No Hydration IntentEmitter — drive the leg by calling `BasejumpProxy.bridgeViaWormhole`
 * directly on Moonbeam (approve WETH, then bridge to the Ethereum IntentRouter with
 * data = (intentId, depositAddress)). Mirrors the full `nintent-ethereum` migration minus
 * its deploy-emitter + set-config@emitter steps.
 *
 * Required PK env vars:
 *   PK_PROXY — Moonbeam deployer
 *   PK       — Ethereum deployer
 *
 * Env file: migrations/envs/<context>/nintent-ethereum-alpha.env
 */
const config: MigrationConfig = {
  name: "nintent-ethereum-alpha",
  description: "Deploy the Intents Moonbeam → Ethereum leg (alpha, no Hydration)",
  pks: ["PK_PROXY", "PK"],

  setup(env) {
    const required = (k: string) => {
      const v = env[k];
      if (!v) throw new Error(`Missing ${k}`);
      return v;
    };

    return {
      moonbeam: wallet.getWallet(
        required("RPC_MOONBEAM"),
        Number(required("CHAIN_ID_MOONBEAM")),
        env.PK_PROXY as `0x${string}`,
      ),
      ethereum: wallet.getWallet(
        required("RPC_ETHEREUM"),
        Number(required("CHAIN_ID_ETHEREUM")),
        env.PK as `0x${string}`,
      ),
    };
  },
};

export default config;
