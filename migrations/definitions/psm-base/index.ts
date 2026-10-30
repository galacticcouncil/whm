import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * HOLLAR Base-USDC peg stability module.
 *
 * Deploys HollarBaseVault on Base and HollarBaseFacilitator on Hydration, binds the two
 * emitters (one-shot, self-freezing), applies the launch parameters, and hands DEFAULT_ADMIN_ROLE
 * to its permanent holder.
 *
 * Steps are grouped by chain: Base 001-003, Hydration 004-007, Base 008-009. The Base key and the
 * Hydration key can belong to different people, so the deployment is three runs, one per group.
 * Neither proxy needs the other's address at init — the emitters are bound afterwards — so the
 * cross-chain dependency is confined to two steps:
 *
 *   005-set-base-emitter@facilitator   Hydration tx, needs the vault address from 001
 *   008-set-hydration-emitter@vault    Base tx, needs the facilitator address from 004
 *
 * Each handover is its chain's last step and follows that contract's bind, because binding needs
 * the admin role: the facilitator's at 007, the vault's at 009. Both binds are one-shot and
 * self-freezing, so a step that runs before the address it needs exists cannot be corrected by
 * re-running it — only by redeploying that side.
 *
 * The PSM compiles under its own compiler profile (see contracts/foundry.toml); the actions read
 * artifacts from contracts/out/. sh/migrate-psm-base.sh builds them first; by hand it is
 *
 *   pnpm --filter @whm/contracts build
 *
 * The emitter binds (005/008) read before they write — an already-bound value is idempotent on
 * resume, a different one throws — and the handovers refuse to hand the role to the deployer
 * itself. A `failed` step still re-runs on every invocation; `--from <next>` does not skip it.
 *
 * 010-011 upgrade the facilitator to the implementation with redeemWithPermit. 010 deploys it with
 * the Hydration key; 011 sends nothing and completes once the proxy delegates to it. The upgrade is
 * DEFAULT_ADMIN_ROLE's, the TC emergency admin since 007, so until its motion enacts 011 fails with
 * the upgradeToAndCall calldata, and the run after the motion records it.
 *
 * Two things this migration deliberately does NOT do, because neither is ours to run:
 *
 *   - GhoToken.addFacilitator(facilitator, label, capacity). Hydration governance — the GHO roles
 *     sit on the dispatcher's AaveManager account, so it is dispatch_as_aave_manager from Root or
 *     the EconomicParameters track, not a technical-committee motion. Until it lands the
 *     facilitator has a zero bucket and mints nothing.
 *   - Unpausing. Both contracts ship paused. Once this migration has bound both emitters
 *     (005/008), the go-live order is redeem unpaused → mint unpaused, once the bucket is granted
 *     and the invariant has been watched → the vault's deposits last, each a guardian action.
 *     Deposits go last because a deposit that lands while mint is paused only queues, and a
 *     queue → cancel → refund loop spends the deposit window for free.
 *
 * Required PK env vars, both on every run (a run that signs on one chain only may pass a throwaway
 * key for the other):
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
