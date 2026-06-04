import { wallet } from "@whm/common";

import type { MigrationConfig } from "./types";

/**
 * Basejump bridge with Base as source.
 *
 * Single merged deployment spanning Hydration (landing), Moonbeam (proxy + transactor),
 * and Base (basejump). All wiring + ownership renunciation included.
 *
 * Required PK env vars:
 *   PK_LANDING — Hydration deployer
 *   PK_PROXY   — Moonbeam deployer
 *   PK         — Base deployer
 *
 * Env file: migrations/envs/<context>/basejump-base.env
 */
const config: MigrationConfig = {
  name: "basejump-base",
  description: "Deploy Basejump bridge with Base as source",
  pks: ["PK_LANDING", "PK_PROXY", "PK"],

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
        env.PK_LANDING as `0x${string}`,
      ),
      moonbeam: wallet.getWallet(
        required("RPC_MOONBEAM"),
        Number(required("CHAIN_ID_MOONBEAM")),
        env.PK_PROXY as `0x${string}`,
      ),
      base: wallet.getWallet(
        required("RPC_BASE"),
        Number(required("CHAIN_ID_BASE")),
        env.PK as `0x${string}`,
      ),
    };
  },
};

export default config;
