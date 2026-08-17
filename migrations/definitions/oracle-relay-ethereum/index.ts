import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Oracle relay with Ethereum as source (direct integration).
 *
 * Ethereum OracleEmitter publishes rate updates (wstETH, apyUSD) via Wormhole.
 * An OracleReceiver on Hydration's EVM verifies the VAA and writes the price
 * straight to the Hydration oracle — no Moonbeam dispatcher / XCM hop.
 *
 * Required PK env vars:
 *   PK_EMITTER  — Ethereum deployer
 *   PK_RECEIVER — Hydration deployer
 *
 * Env file: migrations/envs/<context>/oracle-relay-ethereum.env
 */
const config: MigrationConfig = {
  name: "oracle-relay-ethereum",
  description: "Deploy Ethereum oracle emitter + Hydration OracleReceiver (direct)",
  pks: ["PK_EMITTER", "PK_RECEIVER"],

  setup(env) {
    const required = (k: string) => {
      const v = env[k];
      if (!v) throw new Error(`Missing ${k}`);
      return v;
    };

    return {
      ethereum: wallet.getWallet(
        required("RPC_ETHEREUM"),
        Number(required("CHAIN_ID_ETHEREUM")),
        env.PK_EMITTER as `0x${string}`,
      ),
      hydration: wallet.getWallet(
        required("RPC_HYDRATION"),
        Number(required("CHAIN_ID_HYDRATION")),
        env.PK_RECEIVER as `0x${string}`,
      ),
    };
  },
};

export default config;
