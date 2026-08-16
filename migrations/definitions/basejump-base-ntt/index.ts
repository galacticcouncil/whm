import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Basejump on Base — direct NTT settlement to Hydration.
 *
 * A FRESH deployment, not an upgrade of 0xf5b9334e…529b. The old proxy is owned by
 * the Base Technical Committee Safe (4-of-7) and stays in place; it is disarmed
 * separately with a single owner call, setLandingDest(0), which reverts
 * bridgeViaWormhole before any token is pulled.
 *
 * Deploying fresh keeps every wiring call on the deployer key, removes all
 * storage-layout risk, and reduces the Safe's involvement to that one disarm plus
 * accepting ownership here in step 005.
 *
 * No cross-migration dependency: HYDRATION_LANDING is the EXISTING pool
 * 0x70e9b12c…df976, a known constant, so this migration runs first and start to
 * finish. basejump-hydration then reads its deployed address for setAuthorizedEmitter.
 *
 * Inbound only: setAuthorizedEmitter and setLanding are deliberately never called,
 * so this deployment cannot receive. Hydration -> Base is out of scope.
 *
 * Required PK env vars:
 *   PK — Base deployer
 *
 * Env file: migrations/envs/<context>/basejump-base-ntt.env
 */
const config: MigrationConfig = {
  name: "basejump-base-ntt",
  description: "Deploy Basejump with NTT settlement on Base",
  pks: ["PK"],

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
    };
  },
};

export default config;
