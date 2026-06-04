import { pad } from "viem";

import type { MigrationStep } from "./types";
import { setLandingDest } from "../../actions/basejump/setLandingDest";

const step: MigrationStep = {
  name: "011-set-landing-dest@basejump",
  description: "Register Hydration BasejumpLanding as LandingDest on Basejump",
  action: async (ctx) => {
    const basejumpAddress = ctx.outputs["001-deploy-basejump"].proxyAddress;
    const landingAddress = ctx.outputs["004-deploy-landing"].proxyAddress;

    return await setLandingDest({
      ...ctx.wallet.base,
      basejumpAddress: basejumpAddress as `0x${string}`,
      landingDest: pad(landingAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
