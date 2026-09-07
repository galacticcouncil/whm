import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * HOLLAR Base-USDC peg stability module.
 *
 * Deploys HollarBaseVault on Base and HollarBaseFacilitator on Hydration, binds the two
 * emitters (one-shot, self-freezing), applies the launch parameters, and hands DEFAULT_ADMIN_ROLE
 * to its permanent holder.
 *
 * Step order is Base-first by design, not by accident. Neither proxy needs the other's address at
 * init — the emitters are bound afterwards — so everything that touches only Base is front-loaded
 * (001-003) and Hydration is not touched until 004. That leaves the whole Base leg deployable and
 * configurable in one sitting, and confines the cross-chain dependency to two steps:
 *
 *   005-set-base-emitter@facilitator   Hydration tx, needs the vault address from 001
 *   006-set-hydration-emitter@vault    Base tx, needs the facilitator address from 004
 *
 * The vault's handover (008) has to follow 006, because binding the emitter needs the admin role,
 * so it cannot be front-loaded with the rest of the Base steps. Do not reorder to group by chain:
 * both binds are one-shot and self-freezing, so a step that runs before the address it needs
 * exists cannot be corrected by re-running it — only by redeploying that side.
 *
 * Build first — the PSM contracts live under a separate Foundry profile, and the actions read
 * artifacts from contracts/out-psm/:
 *
 *   FOUNDRY_PROFILE=psm pnpm --filter @whm/contracts build
 *
 * Two things this migration deliberately does NOT do, because neither is ours to run:
 *
 *   - GhoToken.addFacilitator(facilitator, label, capacity). Substrate-side, executed by the technical
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
