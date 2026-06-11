import { pad } from "viem";

import type { MigrationStep } from "./types";
import { setLanding } from "../../actions/basejump/setLanding";

const step: MigrationStep = {
  name: "007-set-landing@basejump",
  description: "Set BasejumpLandingNative as the landing on Ethereum Basejump",
  action: async (ctx) => {
    const basejumpAddress = ctx.outputs["002-deploy-basejump"].proxyAddress;
    const landingAddress = ctx.outputs["003-deploy-landing"].proxyAddress;

    return await setLanding({
      ...ctx.wallet.ethereum,
      basejumpAddress: basejumpAddress as `0x${string}`,
      landing: pad(landingAddress as `0x${string}`, { size: 32 }),
    });
  },
};

export default step;
