import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Oracle relay with Hydration as source, Robinhood Chain as destination.
 *
 * Hydration OracleEmitter publishes the HDX price — the EMA oracle precompile (10m, router route
 * USDT/HDX) read through an immutable AggregatorAdapter that scales its 8 decimals to the emitter's 18.
 * An OracleReceiver on Robinhood verifies the VAA and writes the price straight to the Robinhood
 * oracle.
 *
 * The Robinhood oracle is deployed against this migration's receiver, so the run stops at
 * `006-set-hdx@receiver` until HDX_ORACLE_ADDRESS is filled in — re-run to finish.
 *
 * Required PK env vars:
 *   PK_EMITTER  — Hydration deployer (on the EVM deploy whitelist)
 *   PK_RECEIVER — Robinhood deployer
 *
 * Env file: migrations/envs/<context>/oracle-relay-hydration.env
 */
const config: MigrationConfig = {
  name: "oracle-relay-hydration",
  description: "Deploy Hydration oracle emitter + EMA answer adapter + Robinhood OracleReceiver (direct)",
  pks: ["PK_EMITTER", "PK_RECEIVER"],

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
      robinhood: wallet.getWallet(
        required("RPC_ROBINHOOD"),
        Number(required("CHAIN_ID_ROBINHOOD")),
        env.PK_RECEIVER as `0x${string}`,
      ),
    };
  },
};

export default config;
