import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * BasejumpLanding implementation upgrade on Hydration.
 *
 * The receiver calls the landing's four-argument `transfer` (`…, bytes data`); the pool must
 * dispatch exactly that. A landing proxy running an implementation with any other signature
 * reverts on every `completeTransfer`, and no fast-path payout lands. Storage layout is unchanged
 * by the upgrade, and the pool balance and queue are untouched.
 *
 *   001 deploy BasejumpLanding implementation on Hydration
 *
 * ONE GOVERNANCE ACTION SITS OUTSIDE THIS MIGRATION. The proxy is owner-gated and the owner is the
 * Hydration TC emergency admin (0xaa7e…aa7e1), so the upgrade itself is a TC motion, not a step:
 *
 *   technicalCommittee.propose(threshold,
 *     dispatcher.dispatchAsEmergencyAdmin(
 *       evm.call(admin, landing, upgradeToAndCall(<001-deploy-landing-impl.implAddress>, 0x), ..)))
 *
 * Step 001 records the exact EVM calldata in its output (`upgradeCalldata`, to = the proxy). Nothing
 * initializes: the proxy's storage is already live and the new code reads it unchanged.
 *
 * No ownership step: the implementation has `_disableInitializers()` in its constructor and holds
 * no state of its own; the proxy's owner is untouched.
 *
 * A later landing change is a new step appended here (002-…), never `--from 001`: that resets the
 * step and rewrites this migration's state file, which records the implementation the TC enacted.
 *
 * Build and verify the full motion on a fork before governance:
 *   npx tsx chopsticks/probes/_probeBasejumpLandingUpgrade.ts --impl <implAddress>
 *
 * Required PK env vars:
 *   PK_HYDRATION — Hydration deployer (must hold an EVMAccounts.ContractDeployer slot)
 *
 * Env file: migrations/envs/<context>/basejump-landing-upgrade.env
 */
const config: MigrationConfig = {
  name: "basejump-landing-upgrade",
  description: "Deploy the current BasejumpLanding implementation for the live Hydration pool proxy",
  pks: ["PK_HYDRATION"],

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
        env.PK_HYDRATION as `0x${string}`,
      ),
    };
  },
};

export default config;
