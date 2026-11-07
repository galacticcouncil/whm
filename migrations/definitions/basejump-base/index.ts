import { wallet } from "@whm/common/evm";

import type { MigrationConfig } from "./types";

/**
 * Basejump, Base -> Hydration direct corridor. Both ends in one migration.
 *
 * Two contracts, one per role: BasejumpEmitter on Base, BasejumpReceiver on Hydration.
 * Neither carries the other's entrypoints — the corridor is inbound-only, so a shared base
 * would have given each end four slots it never reads.
 *
 * Supersedes two deployments, both left on chain and disarmed separately with
 * setLandingDest(0) — which reverts bridgeViaWormhole before any token is pulled:
 *   - the MRL stack (Base 0xf5b9334e…529b + Moonbeam proxy + XcmTransactor), committee-owned,
 *     one Safe call. Record: deployments/archive/basejump-base.json
 *   - the first direct NTT source (0x9c007310…c4d2), deployer-owned. Record:
 *     deployments/archive/basejump-base-ntt.json. Replaced rather than upgraded because
 *     dropping its unused tokenBridge slot would shift every slot after it.
 *
 * Base steps (001-004) deploy FRESH and leave the emitter DISARMED: step 002 only checks that
 * `landing` is unset, so `bridgeViaWormhole` reverts `LandingNotSet` before pulling any token.
 * That keeps every wiring call on the deployer key and removes all storage-layout risk. The Safe
 * accepts ownership in step 009 and, as the very last switch-on act, arms the emitter with the
 * call step 011 records.
 *
 * Hydration steps (005-008) deploy the receiver and wire it to the emitter deployed in 001,
 * read straight from ctx.outputs — no env-copied address, so the two ends cannot diverge.
 *
 * REUSES the existing landing 0x70e9b12c…df976, shared with basejump-ethereum and TC-owned.
 * Nothing here deploys or configures it. It does NOT serve Base EURC today: referendum #404
 * unmapped EURC, withdrew the EURC float and seeded USDC. Opening the corridor therefore takes two
 * governance actions after this migration, then the Safe's arming call, none of them a step here:
 *
 *   - Treasury referendum: buy EURC and send the float to the landing
 *   - TC motion on the landing: setDestAsset(EURC, asset 44), then
 *     setAuthorizedBridge(<005-deploy-receiver.proxyAddress>, true)
 *   - Base TC Safe: emitter.setLanding(pad(landing))   <- go-live switch, LAST
 *
 * Steps 010 and 011 send nothing: 010 checks the landing and the EURC settlement leg and records
 * the motion's two landing calls, built from this run's receiver; 011 checks the emitter and
 * records the Safe's arming call. Because the emitter stays disarmed until that call, no user can
 * send EURC into the corridor before its Hydration end is mapped, funded and authorized, so this
 * migration is safe to run in full at any time. Checklist: docs/basejump/base-eurc.md.
 *
 * Inbound only, by code rather than by configuration: the emitter declares no receive path
 * and the receiver no send path. Hydration -> Base is out of scope.
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
