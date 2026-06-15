import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Basejump bridge with Ethereum as source.
 *
 * Deploys Basejump (Ethereum) + BasejumpProxy/XcmTransactor (Moonbeam), wired to the existing
 * basejump-base Hydration landing (HYDRATION_LANDING). Authorizing that landing for this corridor
 * (setAuthorizedBridge + setDestAsset) is a Hydration TC governance action, not part of this run.
 *
 * Required PK env vars:
 *   PK_PROXY — Moonbeam deployer
 *   PK       — Ethereum deployer
 *
 * Env file: migrations/envs/<context>/basejump-ethereum.env
 */
const config: MigrationConfig = {
  name: "basejump-ethereum",
  description: "Deploy Basejump bridge with Ethereum as source",
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
