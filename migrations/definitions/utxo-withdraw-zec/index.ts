import { wallet as nearWallet } from "@whm/common/near";

import type { MigrationConfig } from "./types";

/**
 * UTXO withdraw for Zcash — signs, for an account derived from a Zcash address, the withdrawal of
 * its `zec.omft.near` through Omni's Zcash connector to that address. Design:
 * docs/near-utxo/withdraw.md.
 *
 *   001 deploy utxo-withdraw on NEAR — create, fund, deploy, init in one transaction, after
 *       checking the connector serves the chain and token
 *   002 propose the NEAR custodian as its owner
 *   003 delete the contract account's keys — from here only the owner can upgrade it (`upgrade`).
 *       Refuses unless the code on chain is WITHDRAW_WASM
 *   004 accept the ownership — sent here if the custodian is the deployer; otherwise the custodian
 *       calls `accept_ownership` itself, and this step stops until it has. Re-run to continue
 *
 * The contract account is the MPC derivation predecessor of every withdraw account: once users send
 * to an address derived under it, that account id is permanent, and whoever owns the contract
 * controls those funds.
 *
 * NEAR SIDE ONLY. The Hydration `ZecUtxoEmitter` and the bot are separate.
 *
 * Required PK env vars:
 *   PK_NEAR — NEAR deployer, `ed25519:…`, for NEAR_ACCOUNT (the contract is its sub-account)
 *
 * Env file: migrations/envs/<context>/utxo-withdraw-zec.env
 */
const config: MigrationConfig = {
  name: "utxo-withdraw-zec",
  description: "Deploy the Zcash UTXO withdraw contract",
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
