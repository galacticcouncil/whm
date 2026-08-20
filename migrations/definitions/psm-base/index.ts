import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * HOLLAR Base-USDC peg stability module.
 *
 * Deploys HollarBaseFacilitator on Hydration and HollarBaseVault on Base, binds the two
 * emitters (one-shot, self-freezing), applies the launch parameters, and hands DEFAULT_ADMIN_ROLE
 * to its permanent holder.
 *
 * Build first — the PSM contracts live under a separate Foundry profile, and the actions read
 * artifacts from contracts/out-psm/:
 *
 *   FOUNDRY_PROFILE=psm pnpm --filter @whm/contracts build
 *
 * Two things this migration deliberately does NOT do, because neither is ours to run:
 *
 *   - GhoToken.addFacilitator(vault, label, capacity). Substrate-side, executed by the technical
 *     committee. Until it lands the facilitator has a zero bucket and mints nothing.
 *   - Unpausing. Both contracts ship paused. Redeem is unpaused first, then mint, once the bucket
 *     is granted and the invariant has been watched — a guardian action, after this migration.
 *
 * Required PK env vars:
 *   PK_FACILITATOR — Hydration deployer
 *   PK             — Base deployer
 *
 * Env file: migrations/envs/<context>/psm-base.env
 */
const config: MigrationConfig = {
  name: "psm-base",
  description: "Deploy the HOLLAR Base-USDC peg stability module",
  pks: ["PK_FACILITATOR", "PK"],

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
        env.PK_FACILITATOR as `0x${string}`,
      ),
      base: wallet.getWallet(
        required("RPC_BASE"),
        Number(required("CHAIN_ID_BASE")),
        env.PK as `0x${string}`,
      ),
    };
  },
};

export default config;
