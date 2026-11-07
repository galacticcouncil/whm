import { parseAbi } from "viem";

import type { MigrationStep } from "./types";

const EMITTER_ABI = parseAbi(["function landing() view returns (bytes32)"]);
const ZERO32 = `0x${"00".repeat(32)}`;

/**
 * Sends nothing. The emitter is deployed DISARMED and stays so through this migration: with
 * `landing` unset, `bridgeViaWormhole` reverts `LandingNotSet` before any token is pulled, so no
 * user can send EURC into a corridor whose Hydration end is not yet mapped, funded and authorized.
 *
 * Arming is the last act of the switch-on, by the emitter's owner (the Base TC Safe after step
 * 009): `setLanding(pad(HYDRATION_LANDING))`. Step 011 records that call. It carries the same env
 * value step 007 points the receiver at, so invariant 1 still holds by construction.
 */
const step: MigrationStep = {
  name: "002-check-disarmed@emitter",
  description: "Check the fresh emitter is disarmed (landing unset); arming is the Safe's last call",
  action: async (ctx) => {
    const emitterAddress = ctx.outputs["001-deploy-emitter"].proxyAddress as `0x${string}`;
    const landing = (await ctx.wallet.base.publicClient.readContract({
      address: emitterAddress,
      abi: EMITTER_ABI,
      functionName: "landing",
    })) as string;

    if (landing.toLowerCase() !== ZERO32) {
      throw new Error(`emitter ${emitterAddress} is armed (landing ${landing}); expected unset until switch-on`);
    }

    return { emitterAddress, landing };
  },
};

export default step;
