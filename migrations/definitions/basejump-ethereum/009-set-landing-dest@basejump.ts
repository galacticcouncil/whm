import { pad } from "viem";

import type { MigrationStep } from "./types";
import { setLandingDest } from "../../actions/basejump/setLandingDest";

const step: MigrationStep = {
  name: "009-set-landing-dest@basejump",
  description: "Register existing Hydration BasejumpLanding as LandingDest on Basejump",
  action: async (ctx) => {
    const basejumpAddress = ctx.outputs["001-deploy-basejump"].proxyAddress;
    const landingAddress = ctx.env.HYDRATION_LANDING;
    if (!landingAddress) throw new Error("Missing HYDRATION_LANDING");

    return await setLandingDest({
      ...ctx.wallet.ethereum,
      basejumpAddress: basejumpAddress as `0x${string}`,
      landingDest: pad(landingAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
