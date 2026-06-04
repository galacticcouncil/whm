import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Oracle relay with Ethereum as source.
 *
 * Ethereum OracleEmitter publishes rate updates (wstETH, apyUSD) via Wormhole.
 * Moonbeam dispatcher receives VAAs and forwards to Hydration oracle pallets
 * via XCM transactor.
 *
 * Required PK env vars:
 *   PK_EMITTER — Ethereum deployer
 *   PK_RELAY   — Moonbeam deployer
 *
 * Env file: migrations/envs/<context>/oracle-relay-ethereum.env
 */
const config: MigrationConfig = {
  name: "oracle-relay-ethereum",
  description: "Deploy Ethereum oracle emitter + Moonbeam relay (dispatcher + transactor)",
  pks: ["PK_EMITTER", "PK_RELAY"],

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
      moonbeam: wallet.getWallet(
        required("RPC_MOONBEAM"),
        Number(required("CHAIN_ID_MOONBEAM")),
        env.PK_RELAY as `0x${string}`,
      ),
    };
  },
};

export default config;
