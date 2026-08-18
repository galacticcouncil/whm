import { pad } from "viem";

import type { MigrationStep } from "./types";
import { setLandingDest } from "../../actions/basejump/setLandingDest";

const step: MigrationStep = {
  name: "002-set-landing-dest@basejump",
  description: "Point NTT settlement at the Hydration landing pool",
  action: async (ctx) => {
    const landing = ctx.env.HYDRATION_LANDING;
    if (!landing || /^0x0+$/.test(landing)) {
      throw new Error("HYDRATION_LANDING is unset or zero — it is the existing Hydration pool");
    }

    return await setLandingDest({
      ...ctx.wallet.base,
      basejumpAddress: ctx.outputs["001-deploy-basejump"].proxyAddress as `0x${string}`,
      landingDest: pad(landing as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
