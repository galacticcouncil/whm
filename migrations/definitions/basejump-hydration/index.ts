import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Basejump on Hydration — BasejumpMessageReceiver only.
 *
 * Replaces the Moonbeam hop: the fast-path VAA published by Basejump on the source
 * chain is verified here against Hydration's Wormhole Core and delivered to the
 * landing in the same transaction. No BasejumpProxy, no XcmTransactor, no XCM.
 *
 * REUSES the existing landing 0x70e9b12c…df976 — it already holds the EURC pool, is
 * already mapped EURC -> asset 44, and is already TC-owned. Nothing here deploys or
 * configures it, so no landing ownership transfer is needed either.
 *
 * Because that pool is TC-owned, authorizing this receiver on it is a TC action, NOT
 * a migration step — see docs/basejump/direct-hydration.md. The corridor stays dark
 * until the TC makes that call, which is also the go-live switch.
 *
 * The receiver has no outbound path at all — BasejumpMessageReceiver carries only
 * completeTransfer and its landing wiring, so there is nothing to leave inert.
 *
 * Required PK env vars:
 *   PK — Hydration deployer (must hold an EVMAccounts.ContractDeployer slot)
 *
 * Env file: migrations/envs/<context>/basejump-hydration.env
 */
const config: MigrationConfig = {
  name: "basejump-hydration",
  description: "Deploy BasejumpMessageReceiver on Hydration",
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
