import { wallet as nearWallet } from "@whm/common/near";

import type { MigrationConfig } from "./types";

/**
 * NEAR NTT for ZEC — `zec.omft.near` locked on NEAR, burned and minted on Hydration.
 * Design: docs/near-ntt/spec.md.
 *
 *   001 deploy ntt-manager on NEAR — create, fund, deploy, init in one transaction
 *   002 register it as an emitter on the Wormhole core
 *   003 register its storage on the token
 *   004 peer it with the Hydration manager + transceiver
 *   005 transfer its ownership to the NEAR custodian
 *
 * NEAR SIDE ONLY. The Hydration NttManager (BURNING) and WormholeTransceiver are deployed and
 * configured from hydration-ntt — the usual per-token `add-chain Hydration --mode burning` — and
 * their addresses are copied into this migration's env for step 004. The reverse direction is
 * hydration-ntt's too:
 *
 *   manager.setPeer(15, 0x<001 emitter>, <001 tokenDecimals>, <inbound limit>)
 *   transceiver.setWormholePeer(15, 0x<001 emitter>)
 *
 * `emitter` is `sha256(<001 nttAccount>)` — read it from deployments/<context>/near-ntt-zec.json.
 *
 * OUTSIDE THIS MIGRATION:
 *   - EVMAccounts.set_ntt_minter(assetId, HYDRATION_NTT_MANAGER) — referendum.
 *   - Relayer: an `ntt` route, sourceChain 15, sourceEmitter = 001's `emitter`.
 *   - Removing the NEAR contract account's full-access keys, after the canary — the step that makes
 *     the code immutable. Until then the deployer key can redeploy it.
 *
 * Required PK env vars:
 *   PK_NEAR — NEAR deployer, `ed25519:…`, for NEAR_ACCOUNT (the NTT contract is its sub-account)
 *
 * Env file: migrations/envs/<context>/near-ntt-zec.env
 */
const config: MigrationConfig = {
  name: "near-ntt-zec",
  description: "Deploy the NEAR NTT hub for ZEC",
  pks: ["PK_NEAR"],

  setup(env) {
    const required = (k: string) => {
      const v = env[k];
      if (!v) throw new Error(`Missing ${k}`);
      return v;
    };

    return {
      near: nearWallet.getWallet(required("RPC_NEAR"), required("NEAR_ACCOUNT"), env.PK_NEAR!),
    };
  },
};

export default config;
