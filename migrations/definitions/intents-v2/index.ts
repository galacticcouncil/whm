import { wallet } from "@whm/common/evm";
import { wallet as nearWallet } from "@whm/common/near";

import type { MigrationConfig } from "./types";

/**
 * Intents v2 — unattended swaps and DCA from Hydration into NEAR Intents. Design:
 * docs/intents-v2/spec.md, plan.md §4.
 *
 *   001 deploy IntentDispatcher (UUPS proxy) on Hydration
 *   002 deploy IntentForwarder  (UUPS proxy) on Ethereum
 *   003 deploy IntentRouter on NEAR — create, fund, deploy, `new` in one transaction; emitter = 001
 *   004 authorize relayer 1 @forwarder — the exclusive window on processOrder
 *   005 set the WETH NttManagerWithPayload @dispatcher
 *   006 set the Ethereum forwarder @dispatcher
 *   007 set the Hydration dispatcher @forwarder
 *   008 set the max feed age @dispatcher
 *   009 set the min order amount @dispatcher — POA's ETH minimum
 *   010 set the ZEC price route @dispatcher — checked by pricing it
 *   ── canary ──
 *   011 transfer forwarder ownership to the Ethereum Technical Committee Safe — ETHEREUM_TC_SAFE
 *       stays empty until the canary passes, so a full run stops here, every contract deployer-owned
 *   012 transfer dispatcher ownership to the Hydration Emergency Admin
 *   013 propose the NEAR DAO as the router's owner
 *   014 delete the router account's keys — refuses unless the code on chain is ROUTER_WASM
 *   015 accept the router's ownership — stops until the DAO has; re-run to finish
 *
 * The three reference each other, so all deploy before any is wired, and every cross-chain address
 * is read from ctx.outputs — never copied — so no two ends can diverge. The router pins the
 * dispatcher at init: there is no setter.
 *
 * THE CANARY, between 010 and 011: one small single swap end to end (ICE or `dispatch` → forwarder
 * → POA → `swap` → `deliver`), and one short-deadline action left to `refund`. Router gas, POA's
 * credit against the deposit and the params are checked then, while every fix is still a deployer
 * call: `set_params` and, if needed, a redeploy with the router's key.
 *
 * OUTSIDE THIS MIGRATION:
 *   - Hydration's WETH NttManager runs NttManagerWithPayload (done, hydration-ntt ops/tokens/weth).
 *   - The relayer's intent-v2 route and the NEAR bot.
 *
 * Required PK env vars:
 *   PK           — Hydration deployer (must hold an EVMAccounts.ContractDeployer slot, and enough
 *                  WETH for 12M gas held up front on the dispatcher deploy)
 *   PK_ETHEREUM  — Ethereum deployer
 *   PK_NEAR      — NEAR deployer, `ed25519:…`, for NEAR_ACCOUNT (the router is its sub-account)
 *
 * Env file: migrations/envs/<context>/intents-v2.env
 */
const config: MigrationConfig = {
  name: "intents-v2",
  description: "Deploy intents v2 — Hydration dispatcher, Ethereum forwarder, NEAR router — and wire them",
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
