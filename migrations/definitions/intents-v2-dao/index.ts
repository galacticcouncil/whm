import { wallet } from "@whm/common/evm";
import { wallet as nearWallet } from "@whm/common/near";

import type { MigrationConfig } from "./types";

/**
 * Intents v2 handover — every contract from its deployer to governance, once the canary has passed
 * and the deployer has nothing left to fix:
 *
 *   001 transfer forwarder ownership to the Ethereum Technical Committee Safe
 *   002 transfer dispatcher ownership to the Hydration Emergency Admin
 *   003 propose the NEAR DAO as the router's owner
 *   004 delete the router account's keys — refuses unless the code on chain is ROUTER_WASM
 *   005 accept the router's ownership — stops until the DAO has; re-run to finish
 *
 * After it, every change is a governance call: the dispatcher's routes and upgrades through the
 * Emergency Admin, the forwarder's through the Safe, the router's through the DAO.
 *
 * Required PK env vars:
 *   PK           — Hydration deployer: the dispatcher's owner
 *   PK_ETHEREUM  — Ethereum deployer: the forwarder's owner
 *   PK_NEAR      — NEAR deployer, `ed25519:…`, for NEAR_ACCOUNT: the router's owner and account
 *
 * Env file: migrations/envs/<context>/intents-v2-dao.env — the three RPCs and NEAR_ACCOUNT; the
 * contracts as intents-v2 deployed them (HYDRATION_DISPATCHER, ETHEREUM_FORWARDER, NEAR_ROUTER);
 * the new owners (ETHEREUM_TC_SAFE, HYDRATION_EMERGENCY_ADMIN, ROUTER_NEW_OWNER); ROUTER_WASM.
 */
const config: MigrationConfig = {
  name: "intents-v2-dao",
  description: "Hand intents v2 over to governance — forwarder, dispatcher and router",
  pks: ["PK", "PK_ETHEREUM", "PK_NEAR"],

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
      ethereum: wallet.getWallet(
        required("RPC_ETHEREUM"),
        Number(required("CHAIN_ID_ETHEREUM")),
        env.PK_ETHEREUM as `0x${string}`,
      ),
      near: nearWallet.getWallet(required("RPC_NEAR"), required("NEAR_ACCOUNT"), env.PK_NEAR!),
    };
  },
};

export default config;
