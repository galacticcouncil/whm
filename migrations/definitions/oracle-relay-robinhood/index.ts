import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Oracle relay with Robinhood Chain as source (direct integration).
 *
 * Robinhood OracleEmitter publishes Chainlink prices (SPY/USD) via Wormhole, read through an
 * immutable AggregatorV3Adapter that scales the feed's 8 decimals to the emitter's 18. An
 * OracleReceiver on Hydration's EVM verifies the VAA and writes the price straight to the
 * Hydration oracle.
 *
 * The Hydration oracle is deployed against this migration's receiver, so the run stops at
 * `006-set-spy@receiver` until SPY_ORACLE_ADDRESS is filled in — re-run to finish.
 *
 * Required PK env vars:
 *   PK_EMITTER  — Robinhood deployer
 *   PK_RECEIVER — Hydration deployer
 *
 * Env file: migrations/envs/<context>/oracle-relay-robinhood.env
 */
const config: MigrationConfig = {
  name: "oracle-relay-robinhood",
  description: "Deploy Robinhood oracle emitter + Chainlink adapter + Hydration OracleReceiver (direct)",
  pks: ["PK_EMITTER", "PK_RECEIVER"],

  setup(env) {
    const required = (k: string) => {
      const v = env[k];
      if (!v) throw new Error(`Missing ${k}`);
      return v;
    };

    return {
      robinhood: wallet.getWallet(
        required("RPC_ROBINHOOD"),
        Number(required("CHAIN_ID_ROBINHOOD")),
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
