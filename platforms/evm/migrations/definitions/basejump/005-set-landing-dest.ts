import { pad } from "viem";

import type { MigrationStep } from "../../types";
import { setLandingDest } from "../../actions/basejump/setLandingDest";

const step: MigrationStep = {
  name: "set-landing-dest",
  description: "Register LandingDest (Hydration) on Basejump",
  action: async (ctx) => {
    const basejumpAddress = ctx.outputs["deploy"].proxyAddress;
    const lendingAddress = ctx.ref("basejump-landing", "deploy").proxyAddress;

    return await setLandingDest({
      ...ctx.wallet,
      basejumpAddress: basejumpAddress as `0x${string}`,
      landingDest: pad(lendingAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
