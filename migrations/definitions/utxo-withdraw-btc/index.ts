import { wallet as nearWallet } from "@whm/common/near";

import type { MigrationConfig } from "./types";

/**
 * UTXO withdraw for Bitcoin — signs, for an account derived from a Bitcoin address, the withdrawal
 * of its `nbtc.bridge.near` through Omni's Bitcoin connector to that address. Design:
 * docs/near-utxo/withdraw/spec.md.
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
 * NEAR SIDE ONLY. What it withdraws today is the intents router's deliveries on its nBTC route; a
 * Hydration emitter for BTC comes with a BTC NTT. The relayer is separate.
 *
 * Required PK env vars:
 *   PK_NEAR — NEAR deployer, `ed25519:…`, for NEAR_ACCOUNT (the contract is its sub-account)
 *
 * Env file: migrations/envs/<context>/utxo-withdraw-btc.env
 */
const config: MigrationConfig = {
  name: "utxo-withdraw-btc",
  description: "Deploy the Bitcoin UTXO withdraw contract",
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
