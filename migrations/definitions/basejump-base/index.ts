import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Basejump, Base -> Hydration direct corridor. Both ends in one migration.
 *
 * Supersedes the MRL deployment (Base basejump 0xf5b9334e…529b + Moonbeam proxy +
 * XcmTransactor), whose definition this replaces. That stack stays on chain, owned by
 * its committees; it is disarmed separately with one Safe call, setLandingDest(0), which
 * reverts bridgeViaWormhole before any token is pulled. Its deployment record is kept as
 * deployments/prod/basejump-base-mrl.json.
 *
 * Base steps (001-004) deploy FRESH — not an upgrade of the old proxy. That keeps every
 * wiring call on the deployer key, removes all storage-layout risk, and reduces the Safe's
 * involvement to the disarm plus accepting ownership in step 009.
 *
 * Hydration steps (005-008) deploy the receiver and wire it to the source deployed in 001,
 * read straight from ctx.outputs — no env-copied address, so the two ends cannot diverge.
 *
 * REUSES the existing landing 0x70e9b12c…df976 — it already holds the EURC pool, is already
 * mapped EURC -> asset 44, and is already TC-owned. Nothing here deploys or configures it.
 * Because it is TC-owned, authorizing the receiver on it is a TC action, NOT a step here —
 * see docs/basejump/direct-hydration.md. That call is the go-live switch; until it lands the
 * corridor stays dark and this migration is safe to run in full.
 *
 * Inbound only. The source never gets setAuthorizedEmitter/setLanding, and the receiver has
 * no outbound path at all. Hydration -> Base is out of scope.
 *
 * Required PK env vars:
 *   PK           — Base deployer
 *   PK_HYDRATION — Hydration deployer (must hold an EVMAccounts.ContractDeployer slot)
 *
 * Env file: migrations/envs/<context>/basejump-base.env
 */
const config: MigrationConfig = {
  name: "basejump-base",
  description: "Deploy the direct Base -> Hydration Basejump corridor",
  pks: ["PK", "PK_HYDRATION"],

  setup(env) {
    const required = (k: string) => {
      const v = env[k];
      if (!v) throw new Error(`Missing ${k}`);
      return v;
    };

    return {
      base: wallet.getWallet(
        required("RPC_BASE"),
        Number(required("CHAIN_ID_BASE")),
        env.PK as `0x${string}`,
      ),
      hydration: wallet.getWallet(
        required("RPC_HYDRATION"),
        Number(required("CHAIN_ID_HYDRATION")),
        env.PK_HYDRATION as `0x${string}`,
      ),
    };
  },
};

export default config;
