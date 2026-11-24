import { wallet } from "@whm/common/evm";
import { wallet as nearWallet } from "@whm/common/near";

import type { MigrationConfig } from "./types";

/**
 * Intents v2 upgrades, in order — the record keeps every one; a new upgrade appends its steps:
 *
 *   001 deploy the IntentDispatcher implementation that emits OrderSourced   2026-11-19
 *   002 upgrade the dispatcher proxy to it                                    2026-11-19
 *   003 deploy the IntentDispatcher implementation with `close` — the owner ends a set of terms with a
 *       countdown, publishing a close message; one mapping appended after its storage
 *   004 upgrade the dispatcher proxy to it — the deployer still owns the proxy, so this is a step
 *   005 upgrade the NEAR intent router to ROUTER_WASM — `settle` pays out what the terms' account
 *       holds once a close's countdown has run; its state is unchanged, its owner still the deployer
 *
 * Terms, their accounts and the order message are untouched. Build from the committed source first —
 * `forge build` in contracts/, `cargo near build` in crates/near/contracts/intent-router — and verify
 * both from that source afterwards.
 *
 * Required PK env vars:
 *   PK      — Hydration deployer: the dispatcher's owner (must hold an EVMAccounts.ContractDeployer slot)
 *   PK_NEAR — NEAR deployer, `ed25519:…`, for NEAR_ACCOUNT: the router's owner
 *
 * Env file: migrations/envs/<context>/intents-v2-upgrade.env — HYDRATION_DISPATCHER, RPC_NEAR,
 * NEAR_ACCOUNT, ROUTER_ACCOUNT, ROUTER_WASM beside the Hydration RPC.
 */
const config: MigrationConfig = {
  name: "intents-v2-upgrade",
  description: "Upgrade intents v2 — the Hydration IntentDispatcher and the NEAR IntentRouter",
  pks: ["PK", "PK_NEAR"],

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
      near: nearWallet.getWallet(required("RPC_NEAR"), required("NEAR_ACCOUNT"), env.PK_NEAR!),
    };
  },
};

export default config;
