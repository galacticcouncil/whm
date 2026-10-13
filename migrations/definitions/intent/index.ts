import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Intents v2 — Hydration -> Ethereum corridor. Both ends in one migration.
 *
 * Two contracts, one per role: IntentEmitter on Hydration, IntentReceiver on Ethereum. The emitter
 * swaps to WETH and settles it over NTT, publishing a forwarding instruction beside each settlement;
 * the receiver pairs the two, delivers, and forwards into the deposit address.
 *
 *   001 deploy IntentEmitter  (UUPS proxy) on Hydration
 *   002 deploy IntentReceiver (UUPS proxy) on Ethereum
 *   003 set the WETH NttManager @emitter
 *   004 set the Ethereum IntentReceiver @emitter
 *   005 set the Hydration IntentEmitter @receiver
 *   006 authorize relayer 1 @receiver — exclusive window on processOrder
 *   007 transfer receiver ownership to the Ethereum Technical Committee Safe
 *   008 transfer emitter ownership to the Hydration Emergency Admin
 *
 * The handover ends the migration. Neither end is renounced — both are UUPS and _authorizeUpgrade
 * is onlyOwner, so the custodians keep the upgrade path. Everything owner-gated becomes a 4-of-7
 * Safe transaction or a TC call from 007 onward: another relayer, a new NttManager, sweep, an
 * upgrade. Land those before running it.
 *
 * The two ends reference each other, so both deploy before either is wired. Steps 004/005 read the
 * counterpart straight from ctx.outputs rather than an env-copied address, so they cannot diverge.
 *
 * The NEAR router is deployed separately — it reads the published order off Wormhole and derives its
 * own account from the terms, so it shares no address with either end.
 *
 * Required PK env vars:
 *   PK           — Hydration deployer (must hold an EVMAccounts.ContractDeployer slot)
 *   PK_ETHEREUM  — Ethereum deployer
 *
 * Env file: migrations/envs/<context>/intent.env
 */
const config: MigrationConfig = {
  name: "intent",
  description: "Deploy the Hydration -> Ethereum intents v2 corridor and wire both ends",
  pks: ["PK", "PK_ETHEREUM"],

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
    };
  },
};

export default config;
