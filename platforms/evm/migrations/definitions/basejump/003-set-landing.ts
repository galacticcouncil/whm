import { pad } from "viem";

import type { MigrationStep } from "../../types";
import { setLanding } from "../../actions/basejump/setLanding";

const step: MigrationStep = {
  name: "set-landing",
  description: "Register BasejumpLanding on Basejump",
  action: async (ctx) => {
    const landingAddress = ctx.outputs["deploy-landing"]?.proxyAddress;
    if (!landingAddress) return {}; // No Landing, skip

    const basejumpAddress = ctx.outputs["deploy"].proxyAddress;

    return await setLanding({
      ...ctx.wallet,
      basejumpAddress: basejumpAddress as `0x${string}`,
      landing: pad(landingAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
